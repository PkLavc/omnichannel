# frozen_string_literal: true

# Run inside the Chatwoot container:
# CHATWOOT_ACCOUNT_ID=1 bundle exec rails runner /path/provision-chatwoot-macros.rb
#
# The script is deliberately idempotent. It only creates or updates the global
# Omnichannel shortcuts below; it never deletes user-created macros or changes
# existing conversations.

require "json"

account_id = Integer(ENV.fetch("CHATWOOT_ACCOUNT_ID"))
account = Account.find(account_id)
actor = account.administrators.order(:id).first || account.users.order(:id).first
raise "No account user available for macros" unless actor

resolve = [{ "action_name" => "resolve_conversation", "action_params" => [] }].freeze
close_lost = lambda do |title, reason|
  [title, [{ "action_name" => "add_label", "action_params" => ["resultado:perdido", "motivo:#{reason}"] }] + resolve]
end

macros = [
  ["Fechar - Venda realizada", [{ "action_name" => "add_label", "action_params" => ["resultado:ganho"] }] + resolve],
  close_lost.call("Fechar - Sem venda: Preço", "preco"),
  close_lost.call("Fechar - Sem venda: Estoque", "estoque"),
  close_lost.call("Fechar - Sem venda: Prazo", "prazo"),
  close_lost.call("Fechar - Sem venda: Sem resposta", "sem-resposta"),
  close_lost.call("Fechar - Sem venda: Desistência", "desistencia"),
  close_lost.call("Fechar - Sem venda: Concorrente", "concorrente"),
  close_lost.call("Fechar - Sem venda: Fora do escopo", "fora-do-escopo"),
  close_lost.call("Fechar - Sem venda: Dados incompletos", "dados-incompletos"),
  close_lost.call("Fechar - Sem venda: Outro", "outro"),
  ["Fechar - Suporte resolvido", [{ "action_name" => "add_label", "action_params" => ["encerramento:suporte-resolvido"] }] + resolve],
  ["Fechar - Agendamento concluído", [{ "action_name" => "add_label", "action_params" => ["encerramento:agendamento-concluido"] }] + resolve],
  [
    "Adiar - Aguardando cliente",
    [
      { "action_name" => "add_label", "action_params" => ["espera:cliente"] },
      { "action_name" => "remove_assigned_agent", "action_params" => [] },
      { "action_name" => "remove_assigned_team", "action_params" => [] },
      { "action_name" => "snooze_conversation", "action_params" => [] }
    ]
  ],
  [
    "Devolver para IA",
    [
      { "action_name" => "add_label", "action_params" => ["em_atendimento:ia"] },
      { "action_name" => "remove_assigned_agent", "action_params" => [] },
      { "action_name" => "remove_assigned_team", "action_params" => [] },
      { "action_name" => "change_status", "action_params" => ["pending"] }
    ]
  ]
].freeze

created = []
updated = []
macros.each do |name, actions|
  macro = account.macros.find_or_initialize_by(name: name)
  new_record = macro.new_record?
  macro.visibility = :global
  macro.actions = actions
  macro.created_by ||= actor
  macro.updated_by = actor
  macro.save!
  (new_record ? created : updated) << name
end

puts JSON.generate(created: created, updated: updated, total: macros.length)
