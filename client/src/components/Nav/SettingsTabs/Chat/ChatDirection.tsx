import React from 'react';
import { useSetRecoilState } from 'recoil';
import { Button } from '@librechat/client';
import { useLocalize, useChatDirection } from '~/hooks';
import store from '~/store';

const ChatDirection = () => {
  const direction = useChatDirection();
  const setDirection = useSetRecoilState(store.chatDirection);
  const localize = useLocalize();
  const label =
    direction === 'ltr'
      ? localize('chat_direction_left_to_right')
      : localize('chat_direction_right_to_left');

  /** Flips the direction in effect, which until the first toggle is the UI language's own. */
  const toggleChatDirection = () => {
    setDirection(direction === 'rtl' ? 'LTR' : 'RTL');
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center space-x-2">
        <span id="chat-direction-label">{localize('com_nav_chat_direction')}</span>
      </div>
      <Button
        variant="outline"
        aria-label={localize('com_nav_chat_direction_selected', { direction: label })}
        onClick={toggleChatDirection}
        data-testid="chatDirection"
      >
        {label}
      </Button>
    </div>
  );
};

export default ChatDirection;
