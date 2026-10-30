import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type t from 'librechat-data-provider';
import AgentRow from '../AgentRow';

const mockNavigate = jest.fn();
const mockReset = jest.fn();
jest.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
jest.mock('../MarketplaceContext', () => ({
  useMarketplaceHost: () => ({ resetNewConversation: mockReset }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({ renderAgentAvatar: () => null }));
jest.mock('~/components/ui/Description', () => ({ getPlainDescription: (text: string) => text }));
jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    onClick,
    'aria-label': label,
  }: {
    children: React.ReactNode;
    onClick: () => void;
    'aria-label': string;
  }) => (
    <button onClick={onClick} aria-label={label}>
      {children}
    </button>
  ),
}));

it('opens details separately from starting a new chat', () => {
  const agent = { id: 'agent-1', name: 'Factory', description: 'Help' } as t.Agent;
  const onSelect = jest.fn();
  render(<AgentRow agent={agent} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: /Factory Help/ }));
  expect(onSelect).toHaveBeenCalledWith(agent);
  expect(mockReset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'com_agents_start_chat: Factory' }));
  expect(mockReset).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledWith({
    pathname: '/c/new',
    search: '?endpoint=agents&agent_id=agent-1',
  });
});
