param(
    [string]$ProjectPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
$ruby = @'
if User.exists? && Account.exists?
  Redis::Alfred.delete(Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)
  Account.update_all(locale: "pt_BR")
  User.find_each do |existing_user|
    conversation_filters = existing_user.ui_settings.to_h.fetch("conversations_filter_by", {}).merge(
      "status" => "all"
    )
    existing_user.update!(
      ui_settings: existing_user.ui_settings.to_h.merge(
        "is_conv_actions_open" => true,
        "is_contact_sidebar_open" => true,
        "conversations_filter_by" => conversation_filters
      )
    )
  end
  email = ENV["CHATWOOT_ADMIN_EMAIL"].to_s.strip
  password = ENV["CHATWOOT_ADMIN_PASSWORD"].to_s
  if email.present? && password.present?
    abort "A senha do Chatwoot deve ter ao menos 10 caracteres." if password.length < 10
    user = User.find_by(email: email) || User.first
    user.update!(email: email, password: password, password_confirmation: password, confirmed_at: user.confirmed_at || Time.current)
    puts "Senha do administrador local sincronizada."
  end
  puts "Chatwoot pronto para login."
else
  abort "O Chatwoot ainda nao possui usuario e conta."
end
'@

$ruby | docker compose `
    --project-directory $ProjectPath `
    exec -T chatwoot `
    bundle exec rails runner -

if ($LASTEXITCODE -ne 0) {
    throw "Nao foi possivel finalizar o onboarding existente do Chatwoot."
}
