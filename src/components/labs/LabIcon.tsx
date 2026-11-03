import { iconPaths, type IconName } from './icons';

export function LabIcon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {iconPaths(name).map(d => <path key={d} d={d} />)}
    </svg>
  );
}
