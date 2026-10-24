import { useEffect, useState } from 'react';

/** Hash routes such as #/services or #/gig/12. Older bare links like #services keep working. */
export function parseHash(hash: string): string[] {
  const clean = hash.replace(/^#\/?/, '').split('?')[0];
  return clean ? clean.split('/').map(decodeURIComponent) : ['home'];
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path: string) => {
  location.hash = '#/' + path;
};

export const hashQuery = () => new URLSearchParams(location.hash.split('?')[1] || '');
