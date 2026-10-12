import { useEffect } from 'react';

const APP_NAME = 'YourShop';

/** Set document.title to "<title> · YourShop" while the page is mounted. */
export function useDocumentTitle(title) {
  useEffect(() => {
    if (!title) return undefined;
    const previous = document.title;
    document.title = `${title} · ${APP_NAME}`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

export default useDocumentTitle;
