import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { StorageService } from '../services/storage';
import type { TenantBrand } from '../utils/tenantTheme';

/**
 * The signed-in member's STUDIO look, held above PaperProvider so the whole
 * app re-themes from it (utils/tenantTheme.ts explains what and why).
 *
 * Persisted: a cold start opens in the studio's colors instead of flashing
 * Linyup purple until the profile loads. Cleared with the session — the login
 * screen is always Linyup's (no studio is known there), and a member of two
 * studios sees each one's look after switching.
 */
interface TenantThemeContextValue {
  brand: TenantBrand | null;
  setBrand: (brand: TenantBrand | null) => void;
}

const TenantThemeContext = createContext<TenantThemeContextValue | undefined>(undefined);

export const TenantThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [brand, setBrandState] = useState<TenantBrand | null>(null);

  useEffect(() => {
    StorageService.getTenantBrand<TenantBrand>()
      .then((stored) => {
        if (stored) setBrandState(stored);
      })
      .catch(() => undefined);
  }, []);

  const setBrand = useCallback((next: TenantBrand | null) => {
    setBrandState(next);
    (next ? StorageService.saveTenantBrand(next) : StorageService.removeTenantBrand()).catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ brand, setBrand }), [brand, setBrand]);
  return <TenantThemeContext.Provider value={value}>{children}</TenantThemeContext.Provider>;
};

export function useTenantTheme(): TenantThemeContextValue {
  const ctx = useContext(TenantThemeContext);
  if (!ctx) throw new Error('useTenantTheme must be used within a TenantThemeProvider');
  return ctx;
}
