import { useAtom } from 'jotai';
import { Dropdown } from '@librechat/client';
import type { CalendarPreference } from '~/store/calendar';
import { calendarAtom } from '~/store/calendar';
import { useLocalize } from '~/hooks';

export default function CalendarSelector() {
  const localize = useLocalize();
  const [calendar, setCalendar] = useAtom(calendarAtom);

  const options = [
    { value: 'system', label: localize('com_nav_calendar_system') },
    { value: 'gregorian', label: localize('com_nav_calendar_gregorian') },
    { value: 'persian', label: localize('com_nav_calendar_persian') },
  ];

  const labelId = 'calendar-selector-label';

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div id={labelId}>{localize('com_nav_calendar')}</div>
      <Dropdown
        value={calendar}
        options={options}
        onChange={(value) => setCalendar(value as CalendarPreference)}
        testId="calendar-selector"
        sizeClasses="z-50 w-[150px]"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
}
