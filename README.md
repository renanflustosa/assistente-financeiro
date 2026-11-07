# assistente-financeiro

CLI que importa extratos bancários (OFX ou CSV) para uma planilha de controle financeiro PF + PJ e classifica cada lançamento por regras simples. Tudo roda na sua máquina, sem acessar banco nem passar senha a terceiros: você baixa o extrato no app do banco e o assistente faz o resto.

A planilha mostra, por mês, o que entrou, o que saiu e por quê (Essencial, Escolha, Imposto, Dívida, Poupança, Investimento), separado em PJ e PF, além de orçamento, dívidas (ordem de quitação avalanche) e patrimônio.

O módulo de [FIIs](#fiis) diz em quais fundos imobiliários pôr o aporte do mês, para uma carteira de renda mensal.

## Uso

Requer Node 24 ou mais recente; não há etapa de build.

```bash
npm install
cp config.example.json config.json    # contas e caminho da planilha
cp regras.example.json regras.json    # regras de classificação; ajuste as suas
node src/main.ts nova                 # cria a planilha
node src/main.ts importar extratos/nubank-pf-2026-11.csv --conta "Nubank PF"
node src/main.ts importar extratos/fatura-2026-11.csv --conta "Nubank PF Cartão" --simular
node src/main.ts regra "BAR DO ZE" "Lazer"   # cria a regra e já classifica o que estava em branco
node src/main.ts atualizar            # reaplica as regras depois de editar o regras.json
```

Depois de cada importação, o assistente lista as descrições que ficaram sem categoria. Crie uma regra para elas ou preencha a coluna Categoria direto na planilha.

Reimportar o mesmo extrato, ou um período que se sobrepõe, não duplica nada: cada transação ganha um ID (coluna J de Lancamentos), feito do identificador do banco ou de um hash da data, do valor e da descrição.

`config.json`, `regras.json`, `carteira.json`, os extratos e a planilha ficam fora do git porque guardam os seus dados reais.

## Como baixar o extrato (Nubank)

- **Conta (PF ou PJ)**: no app, Extrato, ícone de exportar, CSV. Colunas `Data,Valor,Identificador,Descrição`.
- **Cartão**: no app, Cartão, Faturas, escolha a fatura, Exportar fatura, CSV. Colunas `date,title,amount`.

Outros bancos: OFX funciona sem configuração. Para CSV, declare um perfil (abaixo).

## config.json

| Campo | O que é |
|---|---|
| `planilha` | Caminho do `.xlsx`, relativo à pasta do projeto ou absoluto |
| `contas` | Uma entrada por conta; o nome aparece na coluna Conta da planilha |
| `contas.<nome>.perfil` | Como ler o CSV dessa conta: `nubank-conta`, `nubank-cartao` ou um perfil próprio. Opcional para OFX |

Perfil próprio de CSV:

```json
"Banco X": {
  "perfil": {
    "separador": ";",
    "decimal": ",",
    "formatoData": "DD/MM/AAAA",
    "pularLinhas": 0,
    "colunas": { "data": "Data", "descricao": "Histórico", "valor": "Valor", "id": "Documento" },
    "inverterSinal": false
  }
}
```

Use `valor` (com sinal, negativo = saída) ou o par `entrada`/`saida`. `inverterSinal` serve para faturas de cartão, que listam compras como valores positivos. Contribuições com perfis de outros bancos são bem-vindas em `src/perfis.ts`.

## regras.json

```json
{ "regras": [
  { "contem": "Pagamento recebido", "ignorar": true },
  { "contem": "Pagamento de fatura", "conta": "Nubank PF", "categoria": "PF - Pagamento fatura cartão" },
  { "contem": ["IFOOD", "RAPPI"], "categoria": "PF - Restaurantes e delivery" }
] }
```

1. **Casamento**: `contem` é um trecho (ou lista de trechos) procurado na descrição, sem diferenciar acento nem maiúscula.
2. **Ordem**: a primeira regra que casa vence. Ponha as específicas antes das genéricas (ex.: `AMAZON WEB SERVICES` antes de `AMAZON`).
3. **Conta**: `conta` limita a regra a uma conta, útil quando o mesmo texto significa coisas diferentes na PF e na PJ.
4. **Ignorar**: `ignorar: true` descarta a transação. Use no "Pagamento recebido" da fatura, que é o espelho do pagamento já lançado na conta.
5. **Sinal**: se a categoria é de Saída e a transação é uma entrada (um estorno, por exemplo), ela fica sem categoria e o assistente avisa.

As categorias são as da aba Config da planilha; o assistente recusa uma regra com categoria que não existe lá. No `regras.example.json`, troque `SEU NOME COMPLETO` e `SUA EMPRESA LTDA` pelos nomes que aparecem nas transferências de pró-labore.

## A planilha

A cada gravação a planilha é regerada pelo código: os valores que você preenche (Config, lançamentos, orçamento planejado, dívidas, patrimônio) são lidos e preservados, mas formatação manual, abas novas, fórmulas editadas, gráficos e imagens se perdem. A versão anterior fica em `.bak`. Feche a planilha no Excel antes de rodar o assistente.

Regras de lançamento estão na aba LEIA-ME. A principal: compras no cartão entram pela fatura, na categoria real; o pagamento da fatura no extrato da conta vai em "Pagamento fatura cartão", que é uma Transferência e não conta como gasto. Assim nada é contado duas vezes.

## FIIs

`node src/main.ts fiis` sugere em quais FIIs pôr o aporte do mês, para uma carteira de longo prazo focada em renda mensal. Ele nunca sugere venda: o rebalanceamento acontece só pelos aportes. Não precisa do `config.json` nem da planilha.

```bash
cp carteira.example.json carteira.json # depois preencha com a sua carteira real
node src/main.ts fiis                  # usa o aporte do carteira.json
node src/main.ts fiis 1500             # aporte deste mês
```

Depois de comprar, atualize `cotas` no `carteira.json`. Ele fica fora do git porque guarda a sua posição real.

| Campo do `carteira.json` | O que é |
|---|---|
| `aporte` | Valor padrão do aporte mensal em R$ |
| `dyMinimo` | DY anual mínimo para comprar (`0.1` = 10%). Define o preço teto |
| `mesesMinimos` | Meses com provento nos últimos 12 para o FII poder ser comprado (`11` tolera um provento com data-com na borda da janela) |
| `rendaAlvo` | Opcional: renda mensal desejada na aposentadoria, em R$ |
| `fiis[].ticker` | Código na B3, ex.: `MXRF11` |
| `fiis[].peso` | Peso relativo na carteira (`1` para todos = pesos iguais; `2` = o dobro) |
| `fiis[].cotas` | Cotas que você já tem |

Os FIIs do exemplo servem só para mostrar o formato; não são recomendação.

1. **Dados**: cotação e proventos dos últimos 12 meses vêm do Yahoo Finance, que não pede chave.
2. **Filtro**: um FII só entra no aporte se pagou provento em pelo menos `mesesMinimos` meses e se o preço está até o **preço teto de Bazin** (`proventos 12m / dyMinimo`). Acima do teto, o DY fica abaixo do mínimo e vale esperar o preço cair.
3. **Aporte**: compra uma cota por vez do FII elegível mais abaixo da meta, proporcionalmente ao peso, até o dinheiro não pagar mais nenhuma cota. O que sobrar fica para o próximo mês.
4. **Saída**: além das compras, mostra a renda mensal estimada (média dos últimos 12 meses), o **número mágico** de cada FII (a partir de quantas cotas o provento do mês compra uma cota nova) e o progresso até a `rendaAlvo`.

Proventos passados não garantem os futuros. A escolha dos FIIs e dos pesos continua sendo sua; a ferramenta só automatiza a decisão de cada mês.

## Checks

```bash
node --test                          # testes (extratos, regras, planilha, FIIs)
node node_modules/typescript/bin/tsc # type-check
```

## Licença

[MIT](LICENSE)
