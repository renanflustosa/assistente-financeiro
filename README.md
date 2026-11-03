# assistente-financeiro

CLI que importa extratos bancários (OFX ou CSV) para uma planilha de controle financeiro PF + PJ e classifica cada lançamento por regras simples. Tudo roda na sua máquina, sem acessar banco nem passar senha a terceiros: você baixa o extrato no app do banco e o assistente faz o resto.

A planilha mostra, por mês, o que entrou, o que saiu e por quê (Essencial, Escolha, Imposto, Dívida, Poupança, Investimento), separado em PJ e PF, além de orçamento, dívidas (ordem de quitação avalanche) e patrimônio.

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

`config.json`, `regras.json`, os extratos e a planilha ficam fora do git porque guardam os seus dados reais.

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

## Checks

```bash
node --test                          # testes (extratos, regras, planilha)
node node_modules/typescript/bin/tsc # type-check
```

## Licença

[MIT](LICENSE)
