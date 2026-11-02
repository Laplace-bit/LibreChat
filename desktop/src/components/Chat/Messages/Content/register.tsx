import { setAppContentParts } from './Parts/slots';
import ContentParts from './ContentParts';

/** Fills the shared message host's content slot with the desktop renderer. */
setAppContentParts(
  ({ isCreatedByUser = false, isLast = true, isLatestMessage, isSubmitting, ...props }) => (
    <ContentParts
      {...props}
      isCreatedByUser={isCreatedByUser}
      isLast={isLast}
      isSubmitting={isSubmitting}
      isLatestMessage={isLatestMessage ?? isSubmitting}
    />
  ),
);
