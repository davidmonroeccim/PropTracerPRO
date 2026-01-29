import Image from 'next/image';

export const dynamic = 'force-dynamic';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
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
  );
}
