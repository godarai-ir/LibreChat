import { memo } from 'react';
import { useLocalize } from '~/hooks';

/**
 * A finished assistant turn that produced nothing. Without it the row is a bare
 * header over the action bar, which reads as still loading or as a rendering
 * fault; the note says the model answered with nothing, so regenerating is the
 * obvious next step.
 */
const EmptyResponse = memo(() => {
  const localize = useLocalize();
  return (
    <p data-testid="empty-response" className="text-text-secondary text-sm">
      {localize('com_ui_response_empty')}
    </p>
  );
});

EmptyResponse.displayName = 'EmptyResponse';

export default EmptyResponse;
