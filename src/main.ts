import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { lerCsv, type PerfilCsv } from './csv.ts';
import { decodificarOfx, lerOfx, type Transacao } from './ofx.ts';
import { PERFIS } from './perfis.ts';
import { gerar, ler, modeloPadrao, salvar, type Dados } from './planilha.ts';
import { importar, normalizar, reclassificar, validarRegras, type Categoria, type Lancamento, type Regra } from './regras.ts';

type Config = { planilha: string; contas: Record<string, { perfil?: string | PerfilCsv }> };

const RAIZ = join(import.meta.dirname, '..');
const ARQ_CONFIG = join(RAIZ, 'config.json');
const ARQ_REGRAS = join(RAIZ, 'regras.json');

const USO = `Uso:
  node src/main.ts nova                                         cria a planilha vazia
  node src/main.ts importar <extrato...> --conta "<conta>" [--simular]
  node src/main.ts regra "<trecho da descrição>" "<categoria>" [--conta "<conta>"]
  node src/main.ts atualizar                                    reaplica as regras e regera a planilha`;

function lerConfig(): Config {
  if (!existsSync(ARQ_CONFIG)) throw new Error(`Falta ${ARQ_CONFIG}: copie config.example.json para config.json.`);
  const c = JSON.parse(readFileSync(ARQ_CONFIG, 'utf8')) as Config;
  const erros: string[] = [];
  if (typeof c.planilha !== 'string' || !c.planilha.toLowerCase().endsWith('.xlsx')) erros.push('planilha deve ser o caminho de um arquivo .xlsx');
  if (typeof c.contas !== 'object' || c.contas === null || Object.keys(c.contas).length === 0) erros.push('contas deve ter ao menos uma conta');
  for (const [nome, conta] of Object.entries(c.contas ?? {})) {
    const p = conta?.perfil;
    if (p === undefined) continue;
    if (typeof p === 'string' && !(p in PERFIS)) erros.push(`contas["${nome}"].perfil "${p}" não existe (prontos: ${Object.keys(PERFIS).join(', ')})`);
    if (typeof p === 'object' && (typeof p.colunas?.data !== 'string' || typeof p.colunas?.descricao !== 'string')) {
      erros.push(`contas["${nome}"].perfil precisa de colunas.data e colunas.descricao`);
    }
  }
  if (erros.length > 0) throw new Error(`config.json inválido:\n- ${erros.join('\n- ')}`);
  return { ...c, planilha: isAbsolute(c.planilha) ? c.planilha : join(RAIZ, c.planilha) };
}

function perfilDe(config: Config, conta: string): PerfilCsv | undefined {
  const p = config.contas[conta]?.perfil;
  return typeof p === 'string' ? PERFIS[p] : p;
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

/** Contas do config.json entram na lista da aba Config (validação da coluna Conta). */
function incluirContas(d: Dados, config: Config) {
  for (const nome of Object.keys(config.contas)) if (!d.contas.includes(nome)) d.contas.push(nome);
}

async function carregar(config: Config): Promise<Dados> {
  if (!existsSync(config.planilha)) throw new Error(`Planilha não encontrada: ${config.planilha}. Crie com: node src/main.ts nova`);
  const d = await ler(config.planilha);
  incluirContas(d, config);
  return d;
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
  console.log('Crie uma regra: node src/main.ts regra "<trecho da descrição>" "<categoria>"  (ou preencha a Categoria na planilha)');
}

async function principal() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { conta: { type: 'string' }, simular: { type: 'boolean' } } });
  const [comando, ...args] = positionals;
  if (comando === undefined) return console.log(USO);
  const config = lerConfig();

  if (comando === 'nova') {
    if (existsSync(config.planilha)) throw new Error(`${config.planilha} já existe.`);
    const d = modeloPadrao(new Date().getFullYear());
    incluirContas(d, config);
    await salvar(gerar(d), config.planilha);
    return console.log(`Planilha criada: ${config.planilha}`);
  }

  if (comando === 'importar') {
    const conta = values.conta;
    if (args.length === 0 || conta === undefined) throw new Error(`Informe os extratos e a conta.\n${USO}`);
    if (!(conta in config.contas)) throw new Error(`Conta "${conta}" não está no config.json (contas: ${Object.keys(config.contas).join(', ')}).`);
    const d = await carregar(config);
    const regras = carregarRegras(d.categorias);
    let total = 0;
    for (const arquivo of args) {
      const r = importar(d.lancamentos, lerExtrato(arquivo, perfilDe(config, conta)), conta, regras, d.categorias);
      d.lancamentos.push(...r.novos);
      total += r.novos.length;
      const semCategoria = r.novos.filter((l) => l.categoria === '').length;
      console.log(`${arquivo}: ${r.novos.length} novos (${semCategoria} sem categoria), ${r.duplicados} já importados, ${r.ignorados} ignorados.`);
      for (const a of r.avisos) console.warn(`  aviso: ${a}`);
      const foraDoAno = r.novos.filter((l) => !l.data.startsWith(String(d.ano))).length;
      if (foraDoAno > 0) console.warn(`  ${foraDoAno} lançamentos fora de ${d.ano}: ficam na aba Lancamentos, mas o Painel mostra só o ano da Config.`);
    }
    if (values.simular) console.log('Simulação: nada foi gravado.');
    else if (total > 0) {
      await salvar(gerar(d), config.planilha);
      console.log(`Gravado em ${config.planilha} (anterior em .bak).`);
    }
    return mostrarPendentes(d.lancamentos);
  }

  if (comando === 'regra') {
    const [trecho, cat] = args;
    if (!trecho || !cat) throw new Error(`Informe o trecho e a categoria.\n${USO}`);
    if (values.conta !== undefined && !(values.conta in config.contas)) throw new Error(`Conta "${values.conta}" não está no config.json.`);
    const d = await carregar(config);
    const brutas = lerRegrasBrutas();
    const nova: Regra = { contem: trecho, categoria: acharCategoria(cat, d.categorias), ...(values.conta ? { conta: values.conta } : {}) };
    const regras = validarRegras([...brutas, nova], d.categorias);
    writeFileSync(ARQ_REGRAS, `${JSON.stringify({ regras: [...brutas, nova] }, null, 2)}\n`);
    const n = reclassificar(d.lancamentos, regras, d.categorias);
    console.log(`Regra salva: "${trecho}" -> ${nova.categoria}${nova.conta ? ` (só ${nova.conta})` : ''}. ${n} lançamentos classificados.`);
    if (n > 0) await salvar(gerar(d), config.planilha);
    return mostrarPendentes(d.lancamentos);
  }

  if (comando === 'atualizar') {
    const d = await carregar(config);
    const n = reclassificar(d.lancamentos, carregarRegras(d.categorias), d.categorias);
    await salvar(gerar(d), config.planilha);
    console.log(`Planilha regerada; ${n} lançamentos classificados agora.`);
    return mostrarPendentes(d.lancamentos);
  }

  throw new Error(`Comando desconhecido: ${comando}\n${USO}`);
}

try {
  await principal();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
