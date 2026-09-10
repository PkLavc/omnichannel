# frozen_string_literal: true

# Chatwoot stores one status preference for every conversation list. The
# Omnichannel interface needs a more useful distinction: a selected inbox may
# show its complete history, while the global "All conversations" queue must
# remain an operational queue containing only active conversations.
module OmnichannelActiveGlobalConversations
  private

  def conversation_finder
    global_all_agents = params[:inbox_id].blank? && params[:assignee_type].to_s == 'all'
    params[:status] = 'open' if global_all_agents && params[:status].to_s == 'all'
    super
  end
end

Rails.application.config.to_prepare do
  controller = Api::V1::Accounts::ConversationsController
  controller.prepend(OmnichannelActiveGlobalConversations) unless controller < OmnichannelActiveGlobalConversations
end
