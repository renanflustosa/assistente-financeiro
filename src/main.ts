import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { conectar, contarIguais, criarEsquema, gravarCategorias, inserirLancamentos, inserirManual, lancamentosDaConta, lerCategorias, lerMes, semCategoria, sincronizarContas, type Banco } from './banco.ts';
import { lerCsv, type PerfilCsv } from './csv.ts';
import { sugerirAporteDoMes } from './fiis/aporte.ts';
import { decodificarOfx, lerOfx, type Transacao } from './ofx.ts';
import { PERFIS } from './perfis.ts';
import { lerData, lerValor } from './manual.ts';
import { classificar, importar, normalizar, reclassificar, validarRegras, type Categoria, type Lancamento, type Regra } from './regras.ts';
import { avalanche, orcamento, painel } from './resumo.ts';

type Config = { mysql: string; contas: Record<string, { perfil?: string | PerfilCsv }> };

const RAIZ = join(import.meta.dirname, '..');
const ARQ_CONFIG = join(RAIZ, 'config.json');
const ARQ_REGRAS = join(RAIZ, 'regras.json');

const USO = `Uso:
  node src/main.ts nova                                         cria o database e as tabelas no MySQL (não apaga nada)
  node src/main.ts importar <extrato...> --conta "<conta>" [--simular]
  node src/main.ts lancar <data> <valor> "<descrição>" --conta "<conta>" [--categoria "<trecho>"] [--entrada] [--repetir] [--simular]
  node src/main.ts regra "<trecho da descrição>" "<categoria>" [--conta "<conta>"]
  node src/main.ts atualizar                                    reaplica as regras nos lançamentos sem categoria
  node src/main.ts resumo [AAAA-MM]                             resumo do mês (padrão: o mês atual)
  node src/main.ts fiis [aporte]                                sugere o aporte do mês em FIIs (carteira.json)`;

function lerConfig(): Config {
  if (!existsSync(ARQ_CONFIG)) throw new Error(`Falta ${ARQ_CONFIG}: copie config.example.json para config.json.`);
  const c = JSON.parse(readFileSync(ARQ_CONFIG, 'utf8')) as Config;
  const erros: string[] = [];
  if (typeof c.mysql !== 'string' || !/^mysql:\/\/[^/]+\/\w+$/.test(c.mysql)) erros.push('mysql deve ser a URL do banco, ex.: mysql://usuario:senha@127.0.0.1:3306/assistente_financeiro');
  if (typeof c.contas !== 'object' || c.contas === null || Object.keys(c.contas).length === 0) erros.push('contas deve ter ao menos uma conta');
  for (const [nome, conta] of Object.entries(c.contas ?? {})) {
    const p = conta?.perfil;
    if (nome.length > 60) erros.push(`contas["${nome}"]: nome com mais de 60 caracteres`);
    if (p === undefined) continue;
    if (typeof p === 'string' && !(p in PERFIS)) erros.push(`contas["${nome}"].perfil "${p}" não existe (prontos: ${Object.keys(PERFIS).join(', ')})`);
    if (typeof p === 'object' && (typeof p.colunas?.data !== 'string' || typeof p.colunas?.descricao !== 'string')) {
      erros.push(`contas["${nome}"].perfil precisa de colunas.data e colunas.descricao`);
    }
  }
  if (erros.length > 0) throw new Error(`config.json inválido:\n- ${erros.join('\n- ')}`);
  return c;
}

function perfilDe(config: Config, conta: string): PerfilCsv | undefined {
  const p = config.contas[conta]?.perfil;
  return typeof p === 'string' ? PERFIS[p] : p;
}

/** Fatura de cartão lista compras como valores positivos; é o que o perfil marca com inverterSinal. */
function contasDoConfig(config: Config) {
  return Object.keys(config.contas).map((nome) => ({ nome, tipo: perfilDe(config, nome)?.inverterSinal ? ('Cartão' as const) : ('Conta' as const) }));
}

/** CSV de banco vem em UTF-8 ou Windows-1252, conforme o banco. */
function decodificarTexto(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function lerExtrato(arquivo: string, perfil: PerfilCsv | undefined): Transacao[] {
  if (!existsSync(arquivo)) throw new Error(`Extrato não encontrado: ${arquivo}`);
  const bytes = readFileSync(arquivo);
  const ext = extname(arquivo).toLowerCase();
  try {
    if (ext === '.ofx' || ext === '.qfx') return lerOfx(decodificarOfx(bytes));
    if (ext === '.csv') {
      if (!perfil) throw new Error('a conta não tem "perfil" no config.json, que diz como ler o CSV');
      return lerCsv(decodificarTexto(bytes), perfil);
    }
    throw new Error('formato não suportado (use .ofx ou .csv)');
  } catch (e) {
    throw new Error(`${arquivo}: ${(e as Error).message}`);
  }
}

function lerRegrasBrutas(): unknown[] {
  if (!existsSync(ARQ_REGRAS)) return [];
  const j = JSON.parse(readFileSync(ARQ_REGRAS, 'utf8')) as { regras?: unknown };
  if (!Array.isArray(j.regras)) throw new Error(`${ARQ_REGRAS}: esperado { "regras": [ ... ] }.`);
  return j.regras;
}

function carregarRegras(categorias: Categoria[]): Regra[] {
  if (!existsSync(ARQ_REGRAS)) console.warn('Sem regras.json: tudo entra sem categoria. Copie regras.example.json para regras.json.');
  return validarRegras(lerRegrasBrutas(), categorias);
}

async function abrir(config: Config): Promise<Banco> {
  const db = await conectar(config.mysql);
  try {
    await sincronizarContas(db, contasDoConfig(config));
    return db;
  } catch (e) {
    await db.end();
    throw e;
  }
}

/** Acha a categoria pelo nome exato ou por um trecho que identifique uma só. */
function acharCategoria(trecho: string, categorias: Categoria[]): string {
  const exata = categorias.find((c) => c.nome === trecho);
  if (exata) return exata.nome;
  const t = normalizar(trecho);
  const achadas = categorias.filter((c) => normalizar(c.nome).includes(t));
  if (achadas.length === 1) return achadas[0]!.nome;
  const lista = (achadas.length > 1 ? achadas : categorias).map((c) => `  ${c.nome}`).join('\n');
  throw new Error(`${achadas.length > 1 ? 'Mais de uma' : 'Nenhuma'} categoria com "${trecho}". Opções:\n${lista}`);
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format;
const pct = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 }).format;

function mostrarPendentes(lancamentos: Lancamento[]) {
  const grupos = new Map<string, { Descrição: string; Vezes: number; Total: number }>();
  for (const l of lancamentos) {
    if (l.categoria !== '') continue;
    const g = grupos.get(normalizar(l.descricao)) ?? { Descrição: l.descricao, Vezes: 0, Total: 0 };
    g.Vezes++;
    g.Total += l.valor;
    grupos.set(normalizar(l.descricao), g);
  }
  if (grupos.size === 0) return console.log('Todos os lançamentos têm categoria.');
  const todos = [...grupos.values()].sort((a, b) => b.Vezes - a.Vezes || b.Total - a.Total);
  console.log(`\nSem categoria: ${todos.reduce((s, g) => s + g.Vezes, 0)} lançamentos. Os mais frequentes:`);
  console.table(todos.slice(0, 15).map((g) => ({ ...g, Total: brl(g.Total) })));
  console.log('Crie uma regra: node src/main.ts regra "<trecho da descrição>" "<categoria>"  (ou preencha a categoria na tabela lancamentos)');
}

async function resumo(db: Banco, mes: string) {
  const d = await lerMes(db, mes);
  const p = painel(d.totais);
  const tabela = (titulo: string, linhas: [string, string][]) => {
    console.log(`\n${titulo}`);
    console.table(Object.fromEntries(linhas.map(([k, v]) => [k, { Valor: v }])));
  };
  console.log(`Resumo de ${mes}`);
  tabela('PJ', [
    ['Entradas', brl(p.pj.entradas)],
    ['Saídas operacionais', brl(p.pj.saidasOperacionais)],
    ['   das quais impostos', brl(p.pj.impostos)],
    ['Lucro do mês', brl(p.pj.lucro)],
    ['Pró-labore / lucros pagos à PF', brl(p.pj.proLabore)],
    ['Fica no caixa da PJ', brl(p.pj.ficaNoCaixa)],
  ]);
  tabela('PF', [
    ['Entradas', brl(p.pf.entradas)],
    ['Gastos', brl(p.pf.gastos)],
    ['   Essencial', brl(p.pf.essencial)],
    ['   Escolha', brl(p.pf.escolha)],
    ['   Imposto', brl(p.pf.imposto)],
    ['   Dívida', brl(p.pf.divida)],
    ['Poupança + investimento', brl(p.pf.poupanca)],
    ['Sobra não alocada', brl(p.pf.sobra)],
    ['Taxa de poupança', pct(p.pf.taxaPoupanca)],
    ['% da renda em Escolha', pct(p.pf.pctEscolha)],
    ['Proventos de FII', brl(p.pf.proventosFii)],
  ]);
  for (const s of d.semCategoria) console.warn(`Sem categoria no mês: ${s.quantos} ${s.sentido === 'Entrada' ? 'entradas' : 'saídas'} (${brl(s.total)}) ficam fora dos totais acima.`);

  const orc = orcamento(d.totais, d.orcamento);
  if (orc.length > 0) {
    console.log('\nOrçamento (planejado em categorias.planejado)');
    console.table(orc.map((o) => ({ Categoria: o.categoria, Planejado: brl(o.planejado), Realizado: brl(o.realizado), Diferença: brl(o.diferenca), '': o.estourou ? 'ACIMA' : '' })));
  }

  if (d.saldos.length > 0 || d.cartoes.length > 0) {
    console.log('\nContas (saldo = saldo_inicial + lançamentos depois de data_saldo)');
    console.table([
      ...d.saldos.map((s) => ({ Conta: s.conta, Saldo: brl(s.saldo), 'Desde': s.dataSaldo })),
      ...d.cartoes.map((c) => ({ Conta: c.conta, 'Compras no mês': brl(c.compras), Limite: c.limite === null ? '' : brl(c.limite) })),
    ]);
  }

  const div = avalanche(d.dividas);
  if (div.length > 0) {
    console.log('\nDívidas: quite primeiro a de ordem 1; nas outras, só o mínimo');
    console.table(
      div.map((x) => ({
        Ordem: x.ordem,
        Credor: x.credor,
        Saldo: brl(x.saldo),
        'Juros a.m.': x.juros === null ? '' : pct(x.juros),
        'Juros/mês': x.jurosMes === null ? '' : brl(x.jurosMes),
        'Meses p/ quitar': x.meses ?? '',
      })),
    );
  }

  const meta = d.custoVida * d.metaMeses;
  if (meta > 0) {
    const reserva = d.reserva?.valor ?? 0;
    console.log(`\nReserva de emergência: ${brl(reserva)}${d.reserva ? ` (fechamento ${d.reserva.mes.slice(0, 7)})` : ''} de ${brl(meta)} (${pct(reserva / meta)}).`);
  }
}

async function principal() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { conta: { type: 'string' }, simular: { type: 'boolean' }, categoria: { type: 'string' }, entrada: { type: 'boolean' }, repetir: { type: 'boolean' } } });
  const [comando, ...args] = positionals;
  if (comando === undefined) return console.log(USO);
  // FIIs usa só o carteira.json; não exige o config.json nem o MySQL.
  if (comando === 'fiis') return sugerirAporteDoMes(args[0]);
  const config = lerConfig();

  if (comando === 'nova') {
    const db = await criarEsquema(config.mysql);
    try {
      await sincronizarContas(db, contasDoConfig(config));
    } finally {
      await db.end();
    }
    return console.log(`Banco pronto: ${new URL(config.mysql).pathname.slice(1)} em ${new URL(config.mysql).host}.`);
  }

  if (!['importar', 'lancar', 'regra', 'atualizar', 'resumo'].includes(comando)) throw new Error(`Comando desconhecido: ${comando}\n${USO}`);
  const db = await abrir(config);
  try {
    if (comando === 'importar') {
      const conta = values.conta;
      if (args.length === 0 || conta === undefined) throw new Error(`Informe os extratos e a conta.\n${USO}`);
      if (!(conta in config.contas)) throw new Error(`Conta "${conta}" não está no config.json (contas: ${Object.keys(config.contas).join(', ')}).`);
      const categorias = await lerCategorias(db);
      const regras = carregarRegras(categorias);
      const novos: Lancamento[] = [];
      for (const arquivo of args) {
        const transacoes = lerExtrato(arquivo, perfilDe(config, conta));
        if (transacoes.length === 0) {
          console.log(`${arquivo}: nenhuma transação.`);
          continue;
        }
        const datas = transacoes.map((t) => t.data).sort();
        const existentes = [...(await lancamentosDaConta(db, conta, datas[0]!, datas.at(-1)!)), ...novos];
        const r = importar(existentes, transacoes, conta, regras, categorias);
        novos.push(...r.novos);
        const semCat = r.novos.filter((l) => l.categoria === '').length;
        console.log(`${arquivo}: ${r.novos.length} novos (${semCat} sem categoria), ${r.duplicados} já importados, ${r.ignorados} ignorados.`);
        for (const a of r.avisos) console.warn(`  aviso: ${a}`);
      }
      if (values.simular) {
        console.log('Simulação: nada foi gravado.');
        return mostrarPendentes(novos);
      }
      // Um INSERT só: ou entram todos os arquivos, ou nenhum.
      await inserirLancamentos(db, novos);
      if (novos.length > 0) console.log(`Gravados ${novos.length} lançamentos.`);
      return mostrarPendentes(await semCategoria(db));
    }

    if (comando === 'lancar') {
      const [dataTxt, valorTxt, descricao] = args;
      const conta = values.conta;
      if (!dataTxt || !valorTxt || !descricao?.trim() || conta === undefined) throw new Error(`Informe data, valor, descrição e conta.\n${USO}`);
      if (!(conta in config.contas)) throw new Error(`Conta "${conta}" não está no config.json (contas: ${Object.keys(config.contas).join(', ')}).`);
      if (descricao.length > 500) throw new Error('Descrição com mais de 500 caracteres.');
      const categorias = await lerCategorias(db);
      const l: Lancamento = { data: lerData(dataTxt), conta, categoria: '', descricao: descricao.trim(), valor: lerValor(valorTxt), id: '' };
      let sentido: 'Entrada' | 'Saída' = values.entrada ? 'Entrada' : 'Saída';
      if (values.categoria !== undefined) {
        const cat = categorias.find((c) => c.nome === acharCategoria(values.categoria!, categorias))!;
        if (values.entrada && cat.tipo === 'Saída') throw new Error(`"${cat.nome}" é categoria de saída, mas foi pedido --entrada.`);
        l.categoria = cat.nome;
        sentido = cat.tipo;
      } else {
        const c = classificar(l.descricao, sentido === 'Saída', conta, carregarRegras(categorias), categorias);
        if (c.ignorar) throw new Error(`Uma regra do regras.json manda ignorar "${l.descricao}"; informe --categoria para lançar mesmo assim.`);
        l.categoria = c.categoria;
        if (c.aviso) console.warn(`aviso: ${c.aviso}`);
      }
      const iguais = await contarIguais(db, l);
      if (iguais > 0 && !values.repetir) throw new Error(`Já existe ${iguais} lançamento igual (${l.data}, ${conta}, ${brl(l.valor)}, "${l.descricao}"). Se é outro gasto de verdade, repita com --repetir.`);
      const linha = `${l.data} ${conta} ${sentido === 'Entrada' ? '+' : '-'}${brl(l.valor)} "${l.descricao}" -> ${l.categoria || 'SEM CATEGORIA'}`;
      if (values.simular) return console.log(`Simulação: ${linha}`);
      await inserirManual(db, l, sentido);
      return console.log(`Lançado: ${linha}`);
    }

    if (comando === 'regra') {
      const [trecho, cat] = args;
      if (!trecho || !cat) throw new Error(`Informe o trecho e a categoria.\n${USO}`);
      if (values.conta !== undefined && !(values.conta in config.contas)) throw new Error(`Conta "${values.conta}" não está no config.json.`);
      const categorias = await lerCategorias(db);
      const brutas = lerRegrasBrutas();
      const nova: Regra = { contem: trecho, categoria: acharCategoria(cat, categorias), ...(values.conta ? { conta: values.conta } : {}) };
      const regras = validarRegras([...brutas, nova], categorias);
      writeFileSync(ARQ_REGRAS, `${JSON.stringify({ regras: [...brutas, nova] }, null, 2)}\n`);
      const pendentes = await semCategoria(db);
      const n = reclassificar(pendentes, regras, categorias);
      await gravarCategorias(db, pendentes);
      console.log(`Regra salva: "${trecho}" -> ${nova.categoria}${nova.conta ? ` (só ${nova.conta})` : ''}. ${n} lançamentos classificados.`);
      return mostrarPendentes(pendentes);
    }

    if (comando === 'atualizar') {
      const categorias = await lerCategorias(db);
      const pendentes = await semCategoria(db);
      const n = reclassificar(pendentes, carregarRegras(categorias), categorias);
      await gravarCategorias(db, pendentes);
      console.log(`${n} lançamentos classificados agora.`);
      return mostrarPendentes(pendentes);
    }

    const mes = args[0] ?? new Date().toLocaleDateString('sv-SE').slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new Error(`Mês inválido: "${mes}" (use AAAA-MM).`);
    return await resumo(db, mes);
  } finally {
    await db.end();
  }
}

try {
  await principal();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
