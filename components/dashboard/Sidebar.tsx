'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Search,
  FileUp,
  History,
  Settings,
  CreditCard,
  Key,
  Link as LinkIcon,
} from 'lucide-react';

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Single Trace', href: '/trace/single', icon: Search },
  { name: 'Bulk Upload', href: '/trace/bulk', icon: FileUp },
  { name: 'History', href: '/history', icon: History },
];

const settingsNav = [
  { name: 'Profile', href: '/settings/profile', icon: Settings },
  { name: 'Billing', href: '/settings/billing', icon: CreditCard },
  { name: 'API Keys', href: '/settings/api-keys', icon: Key },
  { name: 'Integrations', href: '/settings/integrations', icon: LinkIcon },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-64 lg:flex-col">
      <div className="flex grow flex-col gap-y-5 overflow-y-auto border-r border-gray-200 bg-white px-6 pb-4">
        <div className="flex h-16 shrink-0 items-center">
          <Link href="/dashboard">
            <Image src="/logo.png" alt="PropTracerPRO" width={180} height={40} priority />
          </Link>
        </div>
        <nav className="flex flex-1 flex-col">
          <ul className="flex flex-1 flex-col gap-y-7">
            <li>
              <ul className="-mx-2 space-y-1">
                {navigation.map((item) => (
                  <li key={item.name}>
                    <Link
                      href={item.href}
                      className={cn(
                        pathname === item.href
                          ? 'bg-gray-100 text-gray-900'
                          : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900',
                        'group flex gap-x-3 rounded-md p-2 text-sm font-medium leading-6'
                      )}
                    >
                      <item.icon
                        className={cn(
                          pathname === item.href
                            ? 'text-gray-900'
                            : 'text-gray-400 group-hover:text-gray-900',
                          'h-5 w-5 shrink-0'
                        )}
                      />
                      {item.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
            <li>
              <div className="text-xs font-semibold leading-6 text-gray-400">
                Settings
              </div>
              <ul className="-mx-2 mt-2 space-y-1">
                {settingsNav.map((item) => (
                  <li key={item.name}>
                    <Link
                      href={item.href}
                      className={cn(
                        pathname === item.href
                          ? 'bg-gray-100 text-gray-900'
                          : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900',
                        'group flex gap-x-3 rounded-md p-2 text-sm font-medium leading-6'
                      )}
                    >
                      <item.icon
                        className={cn(
                          pathname === item.href
                            ? 'text-gray-900'
                            : 'text-gray-400 group-hover:text-gray-900',
                          'h-5 w-5 shrink-0'
                        )}
                      />
                      {item.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          </ul>
        </nav>
      </div>
    </div>
  );
}
