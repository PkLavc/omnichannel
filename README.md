# Omnichannel Platform

Generic multi-company customer-service platform built around Chatwoot and an AI Gateway. Provider credentials are global and may target all or selected companies. Identity, Commercial/Customer Support behavior, prompts, Chatwoot, RAG, rules, conversations, and business data remain isolated per tenant.

Plataforma multiempresa para atendimento com Chatwoot e AI Gateway. Credenciais de providers são globais e podem atender todas ou empresas selecionadas. Identidade, tratamento Comercial/SAC, prompts, Chatwoot, RAG, regras, conversas e dados de negócio permanecem isolados por tenant.

## Documentation / Documentação

- [English documentation](./docs/en/README.md)
- [Documentação em Português do Brasil](./docs/pt-br/README.md)

## Quick start / Início rápido

1. On Windows, run `Omnichannel.bat` and select **Start**; it discovers the sibling private-data folder, creates `omnichannel-data/config/platform.env`, and downloads MEGA data when configured. It installs no scheduled task or automatic startup entry. / No Windows, execute `Omnichannel.bat` e escolha **Iniciar**; ele encontra a pasta de dados irmã, cria `omnichannel-data/config/platform.env` e baixa os dados do MEGA quando configurado. Nenhuma tarefa agendada ou inicialização automática é instalada.
2. Complete Chatwoot onboarding at `http://localhost:3000` and create each company's inboxes/channels. / Conclua o onboarding do Chatwoot em `http://localhost:3000` e crie as inboxes/canais de cada empresa.
3. Open `http://localhost:3002`, use the local administrative access, and create the first company. A clean installation contains no preconfigured company. / Abra `http://localhost:3002`, use o acesso administrativo local e crie a primeira empresa. Uma instalação limpa não contém empresa pré-configurada.
4. Save and test that company's Chatwoot connection; the stable tenant-ID `message_created` webhook is created or reconciled automatically. / Salve e teste a conexão Chatwoot daquela empresa; o webhook `message_created` com ID estável do tenant é criado ou reconciliado automaticamente.

Chatwoot keeps one technical inbox per channel. Register every WhatsApp, Instagram, Facebook, Website, or API inbox under the same company in the Admin; the Gateway keeps the reply in the original channel and routes human handoff by Commercial, Support, or Post-sale team. / O Chatwoot mantém uma inbox técnica por canal. Cadastre no Admin todas as inboxes de WhatsApp, Instagram, Facebook, Website ou API da mesma empresa; o Gateway responde no canal original e encaminha a transferência humana pela equipe Comercial, SAC/Suporte ou Pós-venda.
5. Use **IA e providers / chaves** to create one or more global credentials with `ALL` or `SELECTED` scope. / Use **IA e providers / chaves** para criar uma ou mais credenciais globais com escopo `ALL` ou `SELECTED`.
6. Select the intended company and use **Conhecimento / RAG** to import its documents manually; onboarding never copies the repository spreadsheet into new tenants automatically. / Selecione a empresa correta e use **Conhecimento / RAG** para importar seus documentos manualmente; o onboarding nunca copia automaticamente a planilha do repositório para tenants novos.

For manual startup, copy `.env.example` to `<OMNICHANNEL_DATA_ROOT>/config/platform.env`, replace every placeholder, set `OMNICHANNEL_DATA_ROOT`, and use that file through `COMPOSE_ENV_FILES`. / Para iniciar manualmente, copie `.env.example` para `<OMNICHANNEL_DATA_ROOT>/config/platform.env`, substitua os placeholders, defina `OMNICHANNEL_DATA_ROOT` e use o arquivo por `COMPOSE_ENV_FILES`.

Provider API keys are encrypted in persistent PostgreSQL storage and survive normal restarts. Keep `GATEWAY_ENCRYPTION_KEY` stable; never put provider keys in Git, Cloudflare Pages, or frontend code. / As API keys dos providers são cifradas no PostgreSQL persistente e sobrevivem a reinícios normais. Mantenha `GATEWAY_ENCRYPTION_KEY` estável; nunca coloque chaves de providers no Git, Cloudflare Pages ou código frontend.

```powershell
docker compose up --build -d
docker compose ps -a
```

## Windows script / Script Windows

- `Omnichannel.bat`: the single Windows menu for starting, stopping, restarting, updating, configuring MEGA, creating backups, opening administrative tools, and installing periodic MEGA backup plus the graceful shutdown handler. It also accepts those actions by command line.

## Services / Serviços

| Service | Address |
| --- | --- |
| Chatwoot | `http://localhost:3000` |
| Admin | `http://localhost:3002` |
| AI Gateway | `http://localhost:3001/health` |
| n8n | `http://localhost:5678` |

The standard stack runs without Ollama. Ollama remains an optional, disabled provider available through the explicit `local-ai` profile.

A stack padrão funciona sem Ollama. O provider Ollama permanece opcional, desabilitado e disponível somente pelo profile explícito `local-ai`.

## Private data / Dados privados

- `omnichannel-data`: private root placed beside the `Omnichannel` repository, for example `Documents/GitHub/omnichannel-data` or `D:/Projects/omnichannel-data`. It contains company configuration, context, raw archives, checkpoints, exports, and `state/current`, the portable snapshot of databases and Docker volumes used for MEGA restore. Copying only `Omnichannel` therefore distributes a clean system with no company data.
- `tenants/<company>/`: private company-specific context, RAG, rules, conversations, contacts, cards, attachments, and datasets.
- `imports` and `exports`: large archives and operational files that never enter Git.
- `apps/gateway/`: Fastify API, Prisma, providers, RAG, memory, Tools, and Chatwoot integration.
- `apps/admin/`: first-use Wizard and administrative interface.

See [MEGA private synchronization](./docs/en/MEGA.md) / [Sincronização privada com MEGA](./docs/pt-br/MEGA.md).

## Validation / Validação

```powershell
npm ci
npm test -w @omnichannel/gateway
docker compose config --quiet
```

See the language-specific installation and deployment guides for security and production limitations.

Consulte os guias de instalação e deployment em cada idioma para limitações de segurança e produção.
