export function Footer() {
  return (
    <footer className="border-t border-gray-200 bg-white py-6 mt-8">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center text-xs text-gray-500 space-y-1">
        <p>
          &copy;2026 Premier Apartment Services, LLC - dba PropTracerPRO&trade; All Rights Reserved
        </p>
        <p>
          853 Dauphin St. Suite C Mobile, AL 36602
        </p>
        <p>
          <a href="https://goacquisitionpro.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-700">
            Privacy Policy
          </a>
          {' | '}
          <a href="https://goacquisitionpro.com/terms-conditions" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-700">
            Terms &amp; Conditions
          </a>
        </p>
      </div>
    </footer>
  );
}
