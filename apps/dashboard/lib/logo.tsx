export function Logo() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* Colibrí muy esquemático: cuerpo, ala y pico. */}
      <path
        d="M4 15c3.2 0 5.6-1.4 7.2-3.6C12.8 9.2 14.6 8 17 8c1.7 0 3 1.2 3 2.9 0 2.6-2.1 4.4-4.7 4.4h-1.1"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.2 15.3 12 20l-2.4-3.1"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="17.6" cy="10.4" r="0.95" fill="currentColor" />
    </svg>
  );
}
