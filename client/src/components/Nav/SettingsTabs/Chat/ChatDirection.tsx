import { useRecoilState } from 'recoil';
import { Dropdown } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';

/** Stored values: `auto` follows the interface language; `RTL` and `LTR` pin a direction. */
const ChatDirection = () => {
  const [preference, setPreference] = useRecoilState(store.chatDirection);
  const localize = useLocalize();

  const options = [
    { value: 'auto', label: localize('com_nav_chat_direction_auto') },
    { value: 'RTL', label: localize('chat_direction_right_to_left') },
    { value: 'LTR', label: localize('chat_direction_left_to_right') },
  ];
  const pinned = preference?.toUpperCase();
  const value = pinned === 'RTL' || pinned === 'LTR' ? pinned : 'auto';
  const labelId = 'chat-direction-label';

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div id={labelId}>{localize('com_nav_chat_direction')}</div>
      <Dropdown
        value={value}
        options={options}
        onChange={(next) => setPreference(next)}
        testId="chatDirection"
        sizeClasses="z-50 w-[150px]"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
};

export default ChatDirection;
