'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Wallet, LogOut, User, Settings, Menu, X,
  LayoutDashboard, Search, FileUp, History,
  CreditCard, Key, Link as LinkIcon,
} from 'lucide-react';
import type { UserProfile } from '@/types';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
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

interface HeaderProps {
  profile: UserProfile;
}

export function Header({ profile }: HeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const getInitials = (email: string) => {
    return email.substring(0, 2).toUpperCase();
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  const getTierBadge = () => {
    switch (profile.subscription_tier) {
      case 'pro':
        return <Badge className="bg-purple-100 text-purple-800">Pro</Badge>;
      case 'starter':
        return <Badge className="bg-blue-100 text-blue-800">Starter</Badge>;
      default:
        return <Badge variant="outline">Pay-As-You-Go</Badge>;
    }
  };

  return (
    <>
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-gray-200 bg-white px-4 shadow-sm sm:gap-x-6 sm:px-6 lg:px-8">
      <div className="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
        <div className="flex flex-1 items-center gap-x-3">
          {/* Mobile menu button */}
          <button
            type="button"
            className="lg:hidden -m-2.5 p-2.5 text-gray-700"
            onClick={() => setMobileMenuOpen(true)}
          >
            <Menu className="h-6 w-6" />
          </button>
          {/* Mobile logo — links to dashboard */}
          <Link href="/" className="lg:hidden text-xl font-bold text-gray-900">
            PropTracerPRO
          </Link>
        </div>

        <div className="flex items-center gap-x-4 lg:gap-x-6">
          {/* Wallet Balance */}
          {profile.subscription_tier === 'wallet' && (
            <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-1.5">
              <Wallet className="h-4 w-4 text-gray-500" />
              <span className="text-sm font-medium text-gray-900">
                {formatCurrency(profile.wallet_balance)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => router.push('/settings/billing')}
              >
                Add Funds
              </Button>
            </div>
          )}

          {/* Subscription Badge */}
          {getTierBadge()}

          {/* AcquisitionPRO Badge */}
          {profile.is_acquisition_pro_member && (
            <Badge className="bg-green-100 text-green-800">
              AcquisitionPRO
            </Badge>
          )}

          {/* User Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-gray-200">
                    {getInitials(profile.email)}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="end" forceMount>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">
                    {profile.company_name || 'My Account'}
                  </p>
                  <p className="text-xs leading-none text-gray-500">
                    {profile.email}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push('/settings/profile')}>
                <User className="mr-2 h-4 w-4" />
                Profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push('/settings/billing')}>
                <Wallet className="mr-2 h-4 w-4" />
                Billing
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push('/settings')}>
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut}>
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>

    {/* Mobile navigation panel */}
    {mobileMenuOpen && (
      <div className="fixed inset-0 z-50 lg:hidden">
        {/* Backdrop */}
        <div className="fixed inset-0 bg-gray-900/50" onClick={() => setMobileMenuOpen(false)} />
        {/* Panel */}
        <div className="fixed inset-y-0 left-0 w-64 bg-white shadow-xl">
          <div className="flex h-16 items-center justify-between px-6 border-b border-gray-200">
            <Link href="/" className="text-xl font-bold text-gray-900" onClick={() => setMobileMenuOpen(false)}>
              PropTracerPRO
            </Link>
            <button type="button" className="-m-2.5 p-2.5 text-gray-700" onClick={() => setMobileMenuOpen(false)}>
              <X className="h-6 w-6" />
            </button>
          </div>
          <nav className="flex flex-col gap-y-5 px-6 py-4">
            <ul className="-mx-2 space-y-1">
              {navigation.map((item) => (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={cn(
                      pathname === item.href
                        ? 'bg-gray-100 text-gray-900'
                        : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900',
                      'group flex gap-x-3 rounded-md p-2 text-sm font-medium leading-6'
                    )}
                  >
                    <item.icon className={cn(
                      pathname === item.href ? 'text-gray-900' : 'text-gray-400',
                      'h-5 w-5 shrink-0'
                    )} />
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
            <div>
              <div className="text-xs font-semibold leading-6 text-gray-400">Settings</div>
              <ul className="-mx-2 mt-2 space-y-1">
                {settingsNav.map((item) => (
                  <li key={item.name}>
                    <Link
                      href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className={cn(
                        pathname === item.href
                          ? 'bg-gray-100 text-gray-900'
                          : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900',
                        'group flex gap-x-3 rounded-md p-2 text-sm font-medium leading-6'
                      )}
                    >
                      <item.icon className={cn(
                        pathname === item.href ? 'text-gray-900' : 'text-gray-400',
                        'h-5 w-5 shrink-0'
                      )} />
                      {item.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </div>
      </div>
    )}
    </>
  );
}
