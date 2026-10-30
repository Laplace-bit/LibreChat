import React, { forwardRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { EModelEndpoint } from 'librechat-data-provider';
import { Button } from '@librechat/client';
import type t from 'librechat-data-provider';
import { getPlainDescription } from '~/components/ui/Description';
import { renderAgentAvatar } from '~/utils';
import { useLocalize } from '~/hooks';
import { useMarketplaceHost } from './MarketplaceContext';

const AgentRow = forwardRef<
  HTMLButtonElement,
  { agent: t.Agent; onSelect: (agent: t.Agent) => void }
>(function AgentRow({ agent, onSelect }, ref) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { resetNewConversation } = useMarketplaceHost();
  const name = agent.name?.trim() || localize('com_ui_agent');
  const startChat = () => {
    const search = new URLSearchParams({ endpoint: EModelEndpoint.agents, agent_id: agent.id });
    resetNewConversation();
    navigate({ pathname: '/c/new', search: `?${search}` });
  };
  return (
    <div className="border-border-light flex min-w-0 items-center gap-3 border-b px-2 py-3">
      {renderAgentAvatar(agent, { size: 'sm', showBorder: false })}
      <button
        ref={ref}
        type="button"
        onClick={() => onSelect(agent)}
        aria-haspopup="dialog"
        className="focus-visible:ring-text-primary min-w-0 flex-1 rounded-md text-start focus-visible:ring-2 focus-visible:outline-hidden"
      >
        <span className="text-text-primary block truncate text-sm font-medium">{name}</span>
        <span className="text-text-secondary block truncate text-sm">
          {getPlainDescription(agent.description).trim() ||
            localize('com_agents_description_empty')}
        </span>
      </button>
      <Button
        variant="outline"
        onClick={startChat}
        aria-label={`${localize('com_agents_start_chat')}: ${name}`}
      >
        {localize('com_agents_start_chat')}
      </Button>
    </div>
  );
});

export default AgentRow;
