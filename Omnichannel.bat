@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Omnichannel Platform
cd /d "%~dp0"

if "%~1"=="" goto Menu
if /i "%~1"=="iniciar" call :Start
if /i "%~1"=="parar" call :Stop
if /i "%~1"=="reiniciar" call :Restart
if /i "%~1"=="atualizar" call :Update
if /i "%~1"=="mega" call :ConfigureMega
if /i "%~1"=="backup" call :Backup
if /i "%~1"=="painel" call :OpenAdmin
if /i "%~1"=="credenciais" call :ShowChatwootCredentials
if /i "%~1"=="status" call :Status
if defined OMNICHANNEL_ACTION_HANDLED exit /b %ERRORLEVEL%
echo Acao desconhecida: %~1
echo Use: Omnichannel.bat [iniciar^|parar^|reiniciar^|atualizar^|mega^|backup^|painel^|credenciais^|status]
exit /b 2

:Menu
cls
echo ============================================================
echo                    OMNICHANNEL
echo ============================================================
echo   1. Iniciar sistema
echo   2. Parar sistema e sincronizar
echo   3. Reiniciar sistema
echo   4. Atualizar codigo e reiniciar
echo   5. Configurar sincronizacao MEGA
echo   6. Fazer backup local
echo   7. Abrir painel administrativo local
echo   8. Ver credenciais locais do Chatwoot
echo   S. Ver status dos containers
echo   X. Sair
echo ============================================================
choice /c 12345678SX /n /m "Escolha uma opcao: "
if errorlevel 10 goto MenuExit
if errorlevel 9 goto MenuStatus
if errorlevel 8 goto MenuCredentials
if errorlevel 7 goto MenuAdmin
if errorlevel 6 goto MenuBackup
if errorlevel 5 goto MenuMega
if errorlevel 4 goto MenuUpdate
if errorlevel 3 goto MenuRestart
if errorlevel 2 goto MenuStop
if errorlevel 1 goto MenuStart
goto Menu

:MenuStart
call :Start
goto MenuPause
:MenuStop
call :Stop
goto MenuPause
:MenuRestart
call :Restart
goto MenuPause
:MenuUpdate
call :Update
goto MenuPause
:MenuMega
call :ConfigureMega
goto MenuPause
:MenuBackup
call :Backup
goto MenuPause
:MenuAdmin
call :OpenAdmin
goto MenuPause
:MenuCredentials
call :ShowChatwootCredentials
goto MenuPause
:MenuStatus
call :Status
goto MenuPause
:MenuExit
exit /b 0

:MenuPause
echo.
pause
goto Menu

:Start
set "OMNICHANNEL_ACTION_HANDLED=1"
title Omnichannel Platform - Iniciar
call :EnsureEnvironment
if errorlevel 1 exit /b 1

echo [1/8] Localizando e sincronizando os dados privados...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Sync-PrivateData.ps1" -Direction Pull -ProjectRoot "%~dp0."
if errorlevel 1 (
  echo ERRO: Nao foi possivel baixar os dados privados. O ambiente nao sera iniciado com dados desatualizados.
  exit /b 1
)

echo [2/8] Verificando o Docker...
where docker >nul 2>&1
if errorlevel 1 (
  echo ERRO: Docker CLI nao encontrado. Instale o Docker Desktop e tente novamente.
  exit /b 1
)
docker compose version >nul 2>&1
if errorlevel 1 (
  echo ERRO: Docker Compose nao esta disponivel.
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 call :StartDockerDesktop
if errorlevel 1 exit /b 1

echo [3/8] Restaurando o estado portatil quando necessario...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Restore-PortableState.ps1" -ProjectRoot "%~dp0."
if errorlevel 1 (
  echo ERRO: Nao foi possivel restaurar os dados privados.
  exit /b 1
)

echo [4/8] Validando a configuracao...
docker compose config --quiet
if errorlevel 1 (
  echo ERRO: docker-compose.yml invalido.
  exit /b 1
)

echo [5/8] Construindo e iniciando os servicos...
docker compose up -d --build
if errorlevel 1 (
  echo ERRO: Nao foi possivel iniciar os servicos.
  docker compose ps --all
  exit /b 1
)

echo [6/8] Aguardando os servicos ficarem prontos...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddMinutes(10); $expected=@(docker compose config --services); do { $rows=@(docker compose ps --all --format json 2>$null | ForEach-Object { $_ | ConvertFrom-Json }); $failed=@($rows | Where-Object { $_.State -eq 'exited' -and [int]$_.ExitCode -ne 0 }); if ($failed.Count -gt 0) { Write-Host ('Falha: ' + (($failed | ForEach-Object { $_.Service + ' (exit ' + $_.ExitCode + ')' }) -join ', ')); exit 2 }; $ready=@($rows | Where-Object { ($_.State -eq 'running' -and (-not $_.Health -or $_.Health -eq 'healthy')) -or ($_.State -eq 'exited' -and [int]$_.ExitCode -eq 0) } | ForEach-Object { $_.Service }); $pending=@($expected | Where-Object { $_ -notin $ready }); if ($pending.Count -eq 0) { exit 0 }; Write-Host ('Aguardando: ' + ($pending -join ', ')); Start-Sleep -Seconds 5 } while ((Get-Date) -lt $deadline); Write-Host ('Tempo limite excedido. Pendentes: ' + ($pending -join ', ')); exit 3"
if errorlevel 1 (
  echo ERRO: Um ou mais servicos nao ficaram prontos.
  docker compose ps --all
  exit /b 1
)

echo Finalizando o cadastro existente do Chatwoot...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Finalize-Chatwoot-Onboarding.ps1"
if errorlevel 1 (
  echo ERRO: O Chatwoot nao reconheceu a conta existente.
  exit /b 1
)

echo [7/8] Publicando o acesso externo...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Start-Public-Access.ps1"
if errorlevel 1 echo AVISO: O ambiente local esta pronto, mas o acesso externo nao foi publicado.

echo [8/8] Ambiente pronto.
docker compose ps --all
if /i not "%NO_BROWSER%"=="1" call :OpenChrome
echo.
echo Chatwoot local:             http://localhost:3000
echo AI Gateway:                http://localhost:3001/health
echo Painel local (recuperacao): http://localhost:3002
exit /b 0

:Stop
set "OMNICHANNEL_ACTION_HANDLED=1"
title Omnichannel Platform - Parar
call :EnsureEnvironment
if errorlevel 1 exit /b 1
where docker >nul 2>&1
if errorlevel 1 (
  echo ERRO: Docker CLI nao encontrado.
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Engine nao esta ativo; o ambiente ja esta parado.
) else (
  echo Salvando clientes, cartoes, conversas, contexto e configuracoes...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Save-PortableState.ps1" -ProjectRoot "%~dp0." -StopServices
  if errorlevel 1 exit /b 1
  docker compose ps --all
)
echo Sincronizando os dados privados com o MEGA...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Sync-PrivateData.ps1" -Direction Push -ProjectRoot "%~dp0."
if errorlevel 1 (
  echo ERRO: Os containers foram parados, mas a sincronizacao MEGA falhou.
  exit /b 1
)
echo Encerrando os acessos publicos iniciados por este projeto...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Stop-Public-Access.ps1" -ProjectRoot "%~dp0."
if errorlevel 1 echo AVISO: Nao foi possivel encerrar um ou mais tuneis publicos.
echo Liberando a memoria usada pelo Docker e WSL...
docker desktop stop --timeout 120 >nul 2>&1
if errorlevel 1 echo AVISO: Feche o Docker Desktop manualmente para liberar toda a memoria do vmmem.
echo Ambiente parado. Os dados foram preservados.
exit /b 0

:Restart
set "OMNICHANNEL_ACTION_HANDLED=1"
call :Stop
if errorlevel 1 exit /b 1
call :Start
exit /b %ERRORLEVEL%

:Update
set "OMNICHANNEL_ACTION_HANDLED=1"
where git >nul 2>&1
if errorlevel 1 (
  echo ERRO: Git nao encontrado.
  exit /b 1
)
echo Atualizando o repositorio...
git pull --ff-only
if errorlevel 1 (
  echo ERRO: Nao foi possivel atualizar. Verifique alteracoes locais e a conexao.
  exit /b 1
)
call :Stop
if errorlevel 1 exit /b 1
call :Start
exit /b %ERRORLEVEL%

:ConfigureMega
set "OMNICHANNEL_ACTION_HANDLED=1"
call :EnsureEnvironment
if errorlevel 1 exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Configure-Mega.ps1" -ProjectRoot "%~dp0."
if errorlevel 1 (
  echo ERRO: A sincronizacao MEGA nao foi configurada.
  exit /b 1
)
echo Configuracao e sincronizacao inicial concluidas.
exit /b 0

:Backup
set "OMNICHANNEL_ACTION_HANDLED=1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Export-Platform-Backup.ps1"
exit /b %ERRORLEVEL%

:OpenAdmin
set "OMNICHANNEL_ACTION_HANDLED=1"
call :EnsureEnvironment
if errorlevel 1 exit /b 1
set "LOCAL_ADMIN_TOKEN="
for /f "usebackq tokens=1,* delims==" %%A in ("%OMNICHANNEL_PLATFORM_ENV%") do if /i "%%A"=="ADMIN_TOKEN" set "LOCAL_ADMIN_TOKEN=%%B"
if not defined LOCAL_ADMIN_TOKEN (
  echo ADMIN_TOKEN nao encontrado na configuracao privada.
  exit /b 1
)
start "" "http://localhost:3002/#admin-token=%LOCAL_ADMIN_TOKEN%"
exit /b 0

:ShowChatwootCredentials
set "OMNICHANNEL_ACTION_HANDLED=1"
call :EnsureEnvironment
if errorlevel 1 exit /b 1
set "CW_EMAIL="
set "CW_PASSWORD="
for /f "usebackq tokens=1,* delims==" %%A in ("%OMNICHANNEL_PLATFORM_ENV%") do (
  if /i "%%A"=="CHATWOOT_ADMIN_EMAIL" set "CW_EMAIL=%%B"
  if /i "%%A"=="CHATWOOT_ADMIN_PASSWORD" set "CW_PASSWORD=%%B"
)
if not defined CW_EMAIL (
  echo Credenciais do Chatwoot ainda nao foram configuradas.
  exit /b 1
)
echo.
echo Chatwoot: http://localhost:3000/app/login
echo Email: %CW_EMAIL%
echo Senha: %CW_PASSWORD%
echo.
echo Estas credenciais sao locais e confidenciais.
start "" "http://localhost:3000/app/login"
exit /b 0

:Status
set "OMNICHANNEL_ACTION_HANDLED=1"
call :EnsureEnvironment
if errorlevel 1 exit /b 1
docker compose ps --all
exit /b %ERRORLEVEL%

:EnsureEnvironment
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker\windows\Initialize-Environment.ps1" -ProjectRoot "%~dp0."
if errorlevel 1 (
  echo ERRO: Nao foi possivel preparar a configuracao privada e localizar omnichannel-data.
  exit /b 1
)
if not exist "%LocalAppData%\Omnichannel\runtime.cmd" (
  echo ERRO: O ambiente privado nao foi localizado.
  exit /b 1
)
call "%LocalAppData%\Omnichannel\runtime.cmd"
findstr /i /c:"change-me" /c:"replace-with" /c:"development-only" "%OMNICHANNEL_PLATFORM_ENV%" >nul 2>&1
if not errorlevel 1 (
  echo ERRO: A configuracao privada ainda contem segredos de exemplo.
  exit /b 1
)
exit /b 0

:StartDockerDesktop
echo Docker Engine indisponivel. Tentando abrir o Docker Desktop...
set "DOCKER_DESKTOP="
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" set "DOCKER_DESKTOP=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if not defined DOCKER_DESKTOP if exist "%LocalAppData%\Docker\Docker Desktop.exe" set "DOCKER_DESKTOP=%LocalAppData%\Docker\Docker Desktop.exe"
if not defined DOCKER_DESKTOP if exist "D:\Apps\Docker\Docker Desktop.exe" set "DOCKER_DESKTOP=D:\Apps\Docker\Docker Desktop.exe"
if not defined DOCKER_DESKTOP (
  echo ERRO: Docker Desktop nao foi encontrado nos caminhos padrao.
  exit /b 1
)
start "" "%DOCKER_DESKTOP%"
for /l %%I in (1,1,120) do (
  docker info >nul 2>&1 && exit /b 0
  if %%I==1 echo Aguardando o Docker Engine...
  timeout /t 5 /nobreak >nul
)
echo ERRO: Docker Engine nao respondeu em 10 minutos.
exit /b 1

:OpenChrome
set "CHROME_PATH="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_PATH if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_PATH if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if defined CHROME_PATH (
  start "" "%CHROME_PATH%" --new-window "http://localhost:3000"
) else (
  start "" "http://localhost:3000"
)
call :OpenAdmin
exit /b 0
