import Image from 'next/image';

export const dynamic = 'force-dynamic';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <div className="flex flex-1 items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center flex flex-col items-center">
            <Image src="/logo.png" alt="PropTracerPRO" width={250} height={55} priority />
            <p className="mt-2 text-sm text-gray-600">
              Skip tracing for commercial real estate professionals
            </p>
          </div>
          {children}
        </div>
      </div>
      <footer className="py-6 text-center text-xs text-gray-500 space-y-1">
        <p>&copy;2026 Premier Apartment Services - dba PropTracerPRO&trade; All Rights Reserved</p>
        <p>853 Dauphin St. Suite C Mobile, AL 36602</p>
        <p>
          <a href="https://goacquisitionpro.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-700">Privacy Policy</a>
          {' | '}
          <a href="https://goacquisitionpro.com/terms-conditions" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-700">Terms &amp; Conditions</a>
        </p>
      </footer>
    </div>
  );
}
