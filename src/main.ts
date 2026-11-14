import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { conectar, contarIguais, criarEsquema, existeTabela, gravarCategorias, importarCarteira, importarContas, importarParametros, importarRegras, inserirLancamentos, inserirManual, inserirRegras, lancamentosDaConta, lerCarteira, lerCategorias, lerContas, lerMes, lerPessoas, lerRegras, semCategoria, type Banco, type Conta } from './banco.ts';
import { lerCsv, type PerfilCsv } from './csv.ts';
import { sugerirAporteDoMes, validarCarteira, type Carteira } from './fiis/aporte.ts';
import { decodificarOfx, lerOfx, type Transacao } from './ofx.ts';
import { PERFIS } from './perfis.ts';
import { lerData, lerValor } from './manual.ts';
import { classificar, importar, normalizar, reclassificar, validarRegras, type Categoria, type Lancamento, type Regra } from './regras.ts';
import { avalanche, orcamento, painel } from './resumo.ts';

/** `contas` só existe em config.json antigo: o `nova` importa para a tabela contas. */
type Config = { mysql: string; contas?: Record<string, { perfil?: string | PerfilCsv }> };

const RAIZ = join(import.meta.dirname, '..');
const ARQ_CONFIG = join(RAIZ, 'config.json');
const ARQ_REGRAS = join(RAIZ, 'regras.json');
const ARQ_CARTEIRA = join(RAIZ, 'carteira.json');

const USO = `Uso (--pessoa "<apelido>" escolhe a pessoa da família; sem ele, o resumo é da família toda):
  node src/main.ts nova [--pessoa "<apelido>"]                  cria o que falta no MySQL (não apaga nada) e importa regras.json e carteira.json
  node src/main.ts importar <extrato...> --conta "<conta>" [--simular]
  node src/main.ts lancar <data> <valor> "<descrição>" --conta "<conta>" [--categoria "<trecho>"] [--entrada] [--repetir] [--simular]
  node src/main.ts regra "<trecho da descrição>" "<categoria>" [--conta "<conta>"]
  node src/main.ts atualizar                                    reaplica as regras nos lançamentos sem categoria
  node src/main.ts resumo [AAAA-MM] [--pessoa "<apelido>"]      resumo do mês (padrão: o mês atual)
  node src/main.ts fiis [aporte] [--pessoa "<apelido>"]         sugere o aporte do mês em FIIs (tabelas pessoas e fiis)`;

function lerConfig(): Config {
  if (!existsSync(ARQ_CONFIG)) throw new Error(`Falta ${ARQ_CONFIG}: copie config.example.json para config.json.`);
  const c = JSON.parse(readFileSync(ARQ_CONFIG, 'utf8')) as Config;
  if (typeof c.mysql !== 'string' || !/^mysql:\/\/[^/]+\/\w+$/.test(c.mysql)) throw new Error('config.json inválido: mysql deve ser a URL do banco, ex.: mysql://usuario:senha@127.0.0.1:3306/assistente_financeiro');
  return c;
}

function perfilDe(conta: Conta): PerfilCsv {
  const p = conta.perfilCsv as PerfilCsv | null;
  if (p !== null) {
    if (typeof p?.colunas?.data !== 'string' || typeof p.colunas.descricao !== 'string') throw new Error(`contas.perfil_csv de "${conta.nome}" precisa de colunas.data e colunas.descricao`);
    return p;
  }
  if (conta.perfil === null) throw new Error(`a conta "${conta.nome}" não tem perfil (contas.perfil), que diz como ler o CSV`);
  const pronto = PERFIS[conta.perfil];
  if (!pronto) throw new Error(`contas.perfil "${conta.perfil}" de "${conta.nome}" não existe (prontos: ${Object.keys(PERFIS).join(', ')})`);
  return pronto;
}

/** CSV de banco vem em UTF-8 ou Windows-1252, conforme o banco. */
function decodificarTexto(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function lerExtrato(arquivo: string, conta: Conta): Transacao[] {
  if (!existsSync(arquivo)) throw new Error(`Extrato não encontrado: ${arquivo}`);
  const bytes = readFileSync(arquivo);
  const ext = extname(arquivo).toLowerCase();
  try {
    if (ext === '.ofx' || ext === '.qfx') return lerOfx(decodificarOfx(bytes));
    if (ext === '.csv') return lerCsv(decodificarTexto(bytes), perfilDe(conta));
    throw new Error('formato não suportado (use .ofx ou .csv)');
  } catch (e) {
    throw new Error(`${arquivo}: ${(e as Error).message}`);
  }
}

async function carregarRegras(db: Banco, categorias: Categoria[]): Promise<Regra[]> {
  const regras = await lerRegras(db);
  if (regras.length === 0) console.warn('A tabela regras está vazia: tudo entra sem categoria. Crie com: node src/main.ts regra "<trecho>" "<categoria>"');
  return validarRegras(regras, categorias);
}

async function contaExistente(db: Banco, nome: string): Promise<Conta> {
  const contas = await lerContas(db);
  const conta = contas.find((c) => c.nome === nome);
  if (!conta) throw new Error(`Conta "${nome}" não está na tabela contas (contas: ${contas.map((c) => c.nome).join(', ') || 'nenhuma'}).`);
  return conta;
}

/** A pessoa pedida, ou a única cadastrada. */
async function escolherPessoa(db: Banco, pedida: string | undefined): Promise<string> {
  const pessoas = await lerPessoas(db);
  if (pedida !== undefined && pessoas.includes(pedida)) return pedida;
  if (pedida === undefined && pessoas.length === 1) return pessoas[0]!;
  if (pessoas.length === 0) throw new Error("Nenhuma pessoa cadastrada: INSERT INTO pessoas (apelido, nome) VALUES ('<apelido>', '<nome completo>')");
  throw new Error(`${pedida === undefined ? 'Informe --pessoa' : `Pessoa "${pedida}" não existe`} (pessoas: ${pessoas.join(', ')}).`);
}

const lerJson = (arquivo: string) => JSON.parse(readFileSync(arquivo, 'utf8')) as Record<string, unknown>;

/**
 * Até 2026-11 contas, regras e carteira ficavam em JSON. O `nova` passa para o banco o que ainda não
 * está lá (regras só com a tabela vazia, carteira só com a pessoa sem FIIs), então pode rodar sempre.
 */
async function importarJsons(db: Banco, config: Config, pessoaPedida: string | undefined): Promise<void> {
  const feitos: string[] = [];
  if (config.contas) {
    await importarContas(
      db,
      Object.entries(config.contas).map(([nome, { perfil }]) => {
        const csv = typeof perfil === 'object' && perfil !== null ? perfil : null;
        const tipo = (csv ?? (typeof perfil === 'string' ? PERFIS[perfil] : undefined))?.inverterSinal ? ('Cartão' as const) : ('Conta' as const);
        return { nome, tipo, perfil: typeof perfil === 'string' ? perfil : null, perfilCsv: csv };
      }),
    );
    feitos.push('"contas" do config.json (agora ele só precisa de "mysql")');
  }
  if (existsSync(ARQ_REGRAS) && (await importarRegras(db, validarRegras(lerJson(ARQ_REGRAS).regras, await lerCategorias(db))))) feitos.push('regras.json');
  const antigos = [existsSync(ARQ_CARTEIRA) && 'carteira.json', (await existeTabela(db, 'parametros')) && 'tabela parametros'].filter((x) => x !== false);
  if (antigos.length > 0) {
    // Carteira e parâmetros antigos não tinham dono: vão para a pessoa escolhida.
    let pessoa: string | undefined;
    try {
      pessoa = await escolherPessoa(db, pessoaPedida);
    } catch (e) {
      console.warn(`Faltou importar ${antigos.join(' e ')}: ${(e as Error).message}`);
    }
    if (pessoa !== undefined) {
      if (existsSync(ARQ_CARTEIRA) && (await importarCarteira(db, pessoa, validarCarteira(lerJson(ARQ_CARTEIRA) as Carteira, 'carteira.json')))) feitos.push(`carteira.json (de ${pessoa})`);
      if (await importarParametros(db, pessoa)) feitos.push(`tabela parametros (de ${pessoa})`);
    }
  }
  if (feitos.length > 0) console.log(`Importado para o banco: ${feitos.join('; ')}. Daqui em diante vale o banco; pode apagar o que veio de arquivo.`);
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

async function resumo(db: Banco, mes: string, pessoa: string | undefined) {
  const d = await lerMes(db, mes, pessoa);
  const p = painel(d.totais);
  const tabela = (titulo: string, linhas: [string, string][]) => {
    console.log(`\n${titulo}`);
    console.table(Object.fromEntries(linhas.map(([k, v]) => [k, { Valor: v }])));
  };
  console.log(`Resumo de ${mes}: ${pessoa ?? 'família'}`);
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
    ['   Cartão (faturas pagas)', brl(p.pf.cartao)],
    ['Poupança + investimento', brl(p.pf.poupanca)],
    ['Sobra não alocada', brl(p.pf.sobra)],
    ['Taxa de poupança', pct(p.pf.taxaPoupanca)],
    ['% da renda em Escolha', pct(p.pf.pctEscolha)],
    ['Proventos de FII', brl(p.pf.proventosFii)],
  ]);
  for (const s of d.semCategoria) console.warn(`Sem categoria no mês: ${s.quantos} ${s.sentido === 'Entrada' ? 'entradas' : 'saídas'} (${brl(s.total)}) ficam fora dos totais acima.`);

  // O orçamento (categorias.planejado) é da família: comparar com o gasto de uma pessoa só confundiria.
  const orc = pessoa === undefined ? orcamento(d.totais, d.orcamento) : [];
  if (orc.length > 0) {
    console.log('\nOrçamento da família (planejado em categorias.planejado)');
    console.table(orc.map((o) => ({ Categoria: o.categoria, Planejado: brl(o.planejado), Realizado: brl(o.realizado), Diferença: brl(o.diferenca), '': o.estourou ? 'ACIMA' : '' })));
  }

  if (d.saldos.length > 0 || d.cartoes.length > 0) {
    console.log('\nContas (saldo = saldo_inicial + lançamentos depois de data_saldo)');
    console.table([
      ...d.saldos.map((s) => ({ Conta: s.conta, Saldo: brl(s.saldo), 'Desde': s.dataSaldo })),
      ...d.cartoes.map((c) => ({ Conta: c.conta, 'Compras no mês': brl(c.compras), 'Limite total': c.limiteTotal === null ? '' : brl(c.limiteTotal), 'Limite disponível': c.limiteDisponivel === null ? '' : brl(c.limiteDisponivel) })),
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

  if (d.metaReserva > 0) {
    const reserva = d.reserva?.valor ?? 0;
    console.log(`\nReserva de emergência: ${brl(reserva)}${d.reserva ? ` (fechamento ${d.reserva.mes.slice(0, 7)})` : ''} de ${brl(d.metaReserva)} (${pct(reserva / d.metaReserva)}).`);
  }
}

async function principal() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { conta: { type: 'string' }, simular: { type: 'boolean' }, categoria: { type: 'string' }, entrada: { type: 'boolean' }, repetir: { type: 'boolean' }, pessoa: { type: 'string' } } });
  const [comando, ...args] = positionals;
  if (comando === undefined) return console.log(USO);
  if (!['nova', 'importar', 'lancar', 'regra', 'atualizar', 'resumo', 'fiis'].includes(comando)) throw new Error(`Comando desconhecido: ${comando}\n${USO}`);
  const config = lerConfig();

  if (comando === 'nova') {
    const db = await criarEsquema(config.mysql);
    try {
      await importarJsons(db, config, values.pessoa);
    } finally {
      await db.end();
    }
    return console.log(`Banco pronto: ${new URL(config.mysql).pathname.slice(1)} em ${new URL(config.mysql).host}.`);
  }

  const db = await conectar(config.mysql);
  try {
    if (comando === 'fiis') return await sugerirAporteDoMes(validarCarteira(await lerCarteira(db, await escolherPessoa(db, values.pessoa)), 'Carteira (tabelas pessoas e fiis)'), args[0]);

    if (comando === 'importar') {
      if (args.length === 0 || values.conta === undefined) throw new Error(`Informe os extratos e a conta.\n${USO}`);
      const conta = await contaExistente(db, values.conta);
      const categorias = await lerCategorias(db);
      const regras = await carregarRegras(db, categorias);
      const novos: Lancamento[] = [];
      for (const arquivo of args) {
        const transacoes = lerExtrato(arquivo, conta);
        if (transacoes.length === 0) {
          console.log(`${arquivo}: nenhuma transação.`);
          continue;
        }
        const datas = transacoes.map((t) => t.data).sort();
        const existentes = [...(await lancamentosDaConta(db, conta.nome, datas[0]!, datas.at(-1)!)), ...novos];
        const r = importar(existentes, transacoes, conta.nome, regras, categorias);
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
      if (!dataTxt || !valorTxt || !descricao?.trim() || values.conta === undefined) throw new Error(`Informe data, valor, descrição e conta.\n${USO}`);
      const conta = (await contaExistente(db, values.conta)).nome;
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
        const c = classificar(l.descricao, sentido === 'Saída', conta, await carregarRegras(db, categorias), categorias);
        if (c.ignorar) throw new Error(`Uma regra da tabela regras manda ignorar "${l.descricao}"; informe --categoria para lançar mesmo assim.`);
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
      if (!trecho?.trim() || !cat) throw new Error(`Informe o trecho e a categoria.\n${USO}`);
      if (trecho.length > 200) throw new Error('Trecho com mais de 200 caracteres.');
      if (values.conta !== undefined) await contaExistente(db, values.conta);
      const categorias = await lerCategorias(db);
      const nova: Regra = { contem: trecho, categoria: acharCategoria(cat, categorias), ...(values.conta ? { conta: values.conta } : {}) };
      validarRegras([nova], categorias);
      await inserirRegras(db, [nova]);
      const pendentes = await semCategoria(db);
      const n = reclassificar(pendentes, await carregarRegras(db, categorias), categorias);
      await gravarCategorias(db, pendentes);
      console.log(`Regra salva: "${trecho}" -> ${nova.categoria}${nova.conta ? ` (só ${nova.conta})` : ''}. ${n} lançamentos classificados.`);
      return mostrarPendentes(pendentes);
    }

    if (comando === 'atualizar') {
      const categorias = await lerCategorias(db);
      const pendentes = await semCategoria(db);
      const n = reclassificar(pendentes, await carregarRegras(db, categorias), categorias);
      await gravarCategorias(db, pendentes);
      console.log(`${n} lançamentos classificados agora.`);
      return mostrarPendentes(pendentes);
    }

    const mes = args[0] ?? new Date().toLocaleDateString('sv-SE').slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new Error(`Mês inválido: "${mes}" (use AAAA-MM).`);
    // Sem --pessoa, a visão da família; com ele, a pessoa precisa existir.
    return await resumo(db, mes, values.pessoa === undefined ? undefined : await escolherPessoa(db, values.pessoa));
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
