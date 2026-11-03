// The body the map shows for the open profile: male or female, from the profile's sex assigned at birth unless a body
// was chosen for that profile on this device (Profile page, "Body map").
import { useEffect, useState } from 'react';
import { useSession } from './session';
import { useStage } from '../components/stage/stageSettings';
import { bodyFor, DEFAULT_BODY, type Body, type BodyChoice } from '../lib/body';

/** Last body shown, for components that mount while signed out. */
let lastShown: Body = DEFAULT_BODY;

/** The open profile's body. While signed out it keeps the last one, so the hidden map does not switch bodies and
 *  start downloading the other model. */
export function useBody(): Body {
  const signedIn = useSession(s => s.status === 'signed-in');
  const id = useSession(s => s.activeId);
  const sex = useSession(s => s.profiles.find(p => p.id === s.activeId)?.sex ?? null);
  const choice = useStage(s => (id ? s.bodies[id] : undefined));
  const current = signedIn && id ? bodyFor(sex, choice ?? 'profile') : null;
  const [last, setLast] = useState<Body>(() => current ?? lastShown);
  // adjusting state while rendering (not in an effect) so the first frame already shows the new body
  if (current && current !== last) setLast(current);
  useEffect(() => { lastShown = last; }, [last]);
  return current ?? last;
}

/** What is stored for a profile on this device: 'profile' when the map follows the profile's sex. */
export function useBodyChoice(profileId: string | null): BodyChoice {
  return useStage(s => (profileId ? s.bodies[profileId] : undefined) ?? 'profile');
}
