# Catálogo sincronizado

O catálogo é uma fonte operacional por empresa. O Gateway consulta a fonte em um intervalo configurado, normaliza apenas produto, código, preço, estoque e disponibilidade, e grava documentos RAG privados para aquele tenant. A IA usa essa cópia como referência rápida; em caso de dúvida ou dado ausente, não inventa preço.

## Segurança

- A URL de origem deve ser HTTPS e não pode apontar para rede local.
- Credenciais da origem são enviadas ao Gateway uma vez, cifradas pelo `ENCRYPTION_KEY` e nunca retornam por API, RAG, logs ou GitHub Actions.
- O workflow público não possui credenciais Omie, SIGE, Zoho ou de qualquer empresa. Ele só chama o Gateway com dois GitHub Secrets: `CATALOG_SYNC_GATEWAY_URL` e `CATALOG_SYNC_TRIGGER_TOKEN`.
- O resultado do workflow contém apenas `due`, `succeeded` e `failed`.

## Contrato da fonte

A fonte deve retornar JSON e uma lista configurável pelo campo `itemsPath`, por exemplo `items`, `data.items` ou `result.products`.

Cada item deve fornecer ao menos um destes campos de nome: `name`, `nome`, `title`, `titulo`, `produto` ou `descricao`. Campos opcionais reconhecidos: `sku`, `codigo`, `id`, `price`, `preco`, `valor`, `stock`, `estoque`, `quantity`, `quantidade`, `available` e `disponivel`.

## Configuração por empresa

No Nexus, abra **Comunicação → Configuração da IA e catálogo**, selecione a empresa e abra **Tools**. A configuração permanece isolada por empresa:

1. Informe URL, caminho da lista, intervalo e autenticação; a credencial é cifrada e não volta à tela.
2. Use **Executar agora** para a primeira atualização manual.
3. O operador da plataforma cadastra os dois secrets do workflow e mantém `CATALOG_SYNC_TRIGGER_TOKEN` igual no `platform.env` privado do Gateway.

O workflow roda a cada quatro horas, mas só atualiza empresas cujo `intervalMinutes` venceu. Para quatro atualizações diárias, use `240`; os demais intervalos devem ser múltiplos de quatro horas. A primeira atualização pode ser disparada manualmente.
