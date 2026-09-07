# Sincronização privada com MEGA

A raiz privada é descoberta automaticamente ao lado do repositório. `Omnichannel.bat` prioriza `omnichannel-data`, reconhece uma única pasta irmã já marcada e cria a pasta padrão quando necessário. A configuração compartilhável da empresa fica em `config/platform.env`; o repositório não guarda `.env` real.

Cada empresa possui pastas próprias para `context`, `rag`, `rules`, `conversations`, `contacts`, `cards`, `attachments` e `datasets`. Os registros que existem somente no PostgreSQL/Chatwoot são incluídos automaticamente no estado portátil criado durante a parada segura.

## Configuração única

1. Crie uma conta MEGA dedicada e confirme o e-mail.
2. Entre nessa conta pelo navegador pelo menos uma vez. Isso gera as chaves criptográficas exigidas pelo MEGA.
3. No computador que possui o acervo original de aproximadamente 8 GB, execute `Omnichannel.bat` e escolha **Configurar sincronização MEGA**. O configurador recusa formar uma cópia mestre a partir de uma pasta local vazia.
4. Informe o e-mail e a senha uma vez. A credencial fica protegida pelo DPAPI do Windows e somente o mesmo usuário naquele computador consegue recuperá-la automaticamente. O valor local fica em `_local/machine.env`, fora do repositório e excluído da sincronização.
5. Se a pasta remota estiver vazia, os arquivos desse computador formam a primeira cópia. Se ela já possuir uma cópia válida e não vazia do Omnichannel, os arquivos remotos são baixados. Um remoto contendo somente o marcador nunca sobrescreve um acervo local existente.

Depois disso, não existe login recorrente: **Iniciar sistema** baixa antes de abrir o Docker e **Parar sistema** pausa os serviços, cria um estado portátil consistente, envia tudo depois da parada graciosa e encerra o Docker Desktop para liberar a memória do `vmmem`. Cada computador novo precisa ser autorizado uma única vez pelo mesmo menu.

O projeto não registra tarefas agendadas, serviços de inicialização nem monitores em segundo plano. Docker, Gateway, Chatwoot e os túneis públicos são iniciados somente pela opção **Iniciar sistema**. A opção **Parar sistema** salva e envia os dados, encerra os túneis iniciados pelo projeto e fecha o Docker Desktop.

O diretório `state/current` contém a cópia restaurável dos bancos PostgreSQL, Redis, anexos do Chatwoot, dados do n8n e segredos de infraestrutura. Ele cobre clientes, cartões, conversas, contexto/RAG e configurações que vivem nos volumes Docker. O arquivo `platform.env` não contém a senha do MEGA nem a credencial DPAPI vinculada ao computador. Em outro computador, o primeiro início restaura automaticamente esse estado; nos inícios seguintes, o identificador em `_local/applied-state-id` impede restaurações desnecessárias.

Use a conta exclusivamente para o Omnichannel e não habilite 2FA nela enquanto o backend do `rclone` exigir um código atual a cada nova sessão; isso impediria a automação sem intervenção.

## Operação manual entre computadores

Antes de trocar de computador, use **Parar sistema** no computador atual para salvar e enviar a versão mais recente. No outro computador, use **Iniciar sistema** para baixar os dados antes de abrir o Docker. Não execute os dois ambientes ao mesmo tempo.

O log fica em `%LOCALAPPDATA%\Omnichannel\logs\shutdown.log`. A subpasta `backups` não é enviada ao MEGA.

Antes de cada envio, o rclone compara o tamanho local com o espaço realmente disponível. Existe uma margem obrigatória de 250 MB; se o conjunto não couber, a sincronização é desativada sem iniciar um upload parcial. Exclusões remotas são permanentes para impedir que versões antigas ocupem a cota reduzida.

Arquivos-fonte grandes podem permanecer em `imports`; os snapshots do banco continuam sendo a fonte portátil do estado de execução. Mantenha exportações brutas fora do Git e compacte-as antes da transferência remota quando necessário.

## Limite importante

MEGA sincroniza arquivos e uma cópia portátil dos volumes; durante a execução, o PostgreSQL continua usando seu volume Docker local. Não ligue dois ambientes com o mesmo webhook simultaneamente. O armazenamento MEGA é temporário e poderá ser substituído pelo servidor próprio sem mudar a localização local de `omnichannel-data`.
