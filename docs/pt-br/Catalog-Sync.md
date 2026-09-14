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

Com sessão administrativa e o tenant selecionado:

1. Envie `PUT /admin/catalog-sync` com URL, caminho da lista, intervalo de 15 a 10.080 minutos e autenticação da fonte.
2. Use `POST /admin/catalog-sync/run` para a primeira atualização manual.
3. Cadastre os dois secrets do workflow no repositório e mantenha `CATALOG_SYNC_TRIGGER_TOKEN` igual no `platform.env` privado do Gateway.

O workflow roda a cada 15 minutos, mas só atualiza empresas cujo `intervalMinutes` venceu. Para quatro atualizações diárias, use `240`.
