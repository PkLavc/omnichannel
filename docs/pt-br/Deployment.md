# Deployment

O Compose incluído é destinado a desenvolvimento e homologação controlada. O comando padrão não inicia Ollama:

```powershell
docker compose up --build -d
```

## Checklist para produção

- Guardar segredos fortes do banco, Gateway, Admin, n8n e Chatwoot fora do código.
- Manter a chave de criptografia do Gateway estável e com backup.
- Manter as API keys globais dos providers cifradas no PostgreSQL; revisar cada uma das múltiplas configurações por nome, tipo, prioridade, escopo `ALL` ou relações `SELECTED`, sem incorporá-las ao Admin estático, Cloudflare Pages ou qualquer bundle frontend.
- Publicar Chatwoot, Admin e Gateway atrás de TLS e proxy autenticado.
- Para Cloudflare, usar um domínio gerenciado e um Named Tunnel com hostname estável. Cloudflare Pages hospeda o Nexus estático, mas não alcança o `localhost` da máquina; Quick Tunnels servem apenas para testes e mudam de endereço.
- Não expor PostgreSQL, Redis ou a instância Ollama opcional.
- Usar o login centralizado do Nexus para o Admin, proteger a própria conta Nexus com controles adequados e revisar periodicamente `omnichannelAccess` e as empresas de cada usuário. Manter `ADMIN_TOKEN` somente no secret manager do backend, nunca em URL ou frontend.
- Não confundir o link protegido com SSO do Chatwoot. Na edição Community, o Chatwoot mantém autenticação própria; SSO obrigatório requer uma edição/recurso compatível ou a adoção planejada de um provedor OAuth comum.
- Exigir `X-Tenant-Id` do `PLATFORM_ADMIN` em toda rota tenant-scoped e nunca tratar o header isoladamente como autorização.
- Manter `COMMERCIAL_EVENTS_TOKEN` somente no secret manager do backend; entregar às integrações apenas os tokens derivados por tenant.
- Manter um segredo de webhook por tenant, usar a rota canônica estável com ID opaco, preservar a compatibilidade de slug, rotacionar quando necessário, usar HTTPS e impedir que proxies registrem segredos.
- Implantar backup e restauração testados para PostgreSQL e volumes persistentes.
- Executar testes de isolamento entre pelo menos dois tenants antes de cada release.
- Centralizar logs, métricas, tracing e alertas de provider, RAG, Tool e entrega.

## Escalabilidade

Uma instância do Gateway processa conversas diferentes em paralelo e serializa localmente cada conversa. Múltiplas réplicas exigem fila distribuída, lock e coordenação de idempotência. Um reinício pode interromper uma tarefa que já retornou HTTP `202`.

O profile `local-ai` é uma opção futura. Ele exige download explícito de modelos e planejamento separado de CPU/GPU, armazenamento e rede privada.

## Oracle Cloud Free Tier para homologação

O arquivo `docker-compose.oracle.yml` complementa o Compose principal para uma VM Ubuntu ARM64. Ele:

- aplica `restart: unless-stopped` somente aos serviços permanentes;
- não inicia nem baixa Ollama;
- mantém PostgreSQL, Redis, n8n e as portas locais fora da Internet;
- publica Chatwoot e Gateway pelo mesmo Quick Tunnel HTTPS, com roteamento interno;
- fixa a imagem funcional do `cloudflared` por digest;
- atualiza automaticamente o manifesto do Nexus quando o endereço temporário muda.

Arquivos privados esperados na VM:

```text
/opt/omnichannel-data/config/platform.env
/opt/omnichannel-data/config/publication.env
```

`publication.env` deve ter permissão `0600` e conter `GITHUB_TOKEN`, `PUBLIC_STATUS_GIST_ID` e, opcionalmente, `PUBLIC_STATUS_GIST_FILENAME`. Esse token deve ter apenas a permissão necessária para editar o Gist de status. Nenhum desses valores deve entrar no Git.

Depois de construir a imagem local do Gateway, valide e suba com:

```bash
docker compose --env-file /opt/omnichannel-data/config/platform.env \
  -f docker-compose.yml -f docker-compose.oracle.yml config --quiet
docker compose --env-file /opt/omnichannel-data/config/platform.env \
  -f docker-compose.yml -f docker-compose.oracle.yml build gateway
docker compose --env-file /opt/omnichannel-data/config/platform.env \
  -f docker-compose.yml -f docker-compose.oracle.yml up -d
```

Instale `docker/oracle/omnichannel.service` e `docker/oracle/omnichannel-publisher.service` em `/etc/systemd/system/`, execute `systemctl daemon-reload` e habilite ambos. O primeiro mantém os containers ativos continuamente e os inicia após reinicializações da VM. O segundo publica o manifesto no Nexus e o marca como offline quando o serviço principal é encerrado. Não há desligamento agendado.

O MEGA é opcional e atua diretamente entre a Oracle e o armazenamento remoto, sem depender de um computador local. As credenciais ficam somente em `/opt/omnichannel-data/config/mega.env`, com permissão `0600`. Os scripts `save-portable-state.sh` e `mega-sync.sh` geram e enviam o snapshot; o timer de backup deve ser habilitado somente depois de validar as credenciais e o destino remoto.

Quick Tunnel é adequado apenas para esta homologação de baixo uso: o hostname pode mudar e não há garantia de disponibilidade. Em produção, substitua-o por um hostname estável sem expor diretamente banco, Redis ou tokens administrativos.
