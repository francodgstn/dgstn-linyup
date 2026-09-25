import AsyncStorage from '@react-native-async-storage/async-storage';

const EMAIL_KEY = '@linyup_email';
const CODE_ID_KEY = '@linyup_code_id';
const SELECTED_CONTACT_ID_KEY = '@linyup_contact_id';
const STAY_LOGGED_IN_KEY = '@linyup_stay_logged_in';
const SESSION_EXPIRES_KEY = '@linyup_session_expires';
const TENANT_BRAND_KEY = '@linyup_tenant_brand';

export const StorageService = {
  // Email
  async saveEmail(email: string): Promise<void> {
    await AsyncStorage.setItem(EMAIL_KEY, email);
  },

  async getEmail(): Promise<string | null> {
    return await AsyncStorage.getItem(EMAIL_KEY);
  },

  async removeEmail(): Promise<void> {
    await AsyncStorage.removeItem(EMAIL_KEY);
  },

  // Code ID (for verification step)
  async saveCodeId(codeId: string): Promise<void> {
    await AsyncStorage.setItem(CODE_ID_KEY, codeId);
  },

  async getCodeId(): Promise<string | null> {
    return await AsyncStorage.getItem(CODE_ID_KEY);
  },

  async removeCodeId(): Promise<void> {
    await AsyncStorage.removeItem(CODE_ID_KEY);
  },

  // Selected Contact ID
  async saveSelectedContactId(contactId: string): Promise<void> {
    await AsyncStorage.setItem(SELECTED_CONTACT_ID_KEY, contactId);
  },

  async getSelectedContactId(): Promise<string | null> {
    return await AsyncStorage.getItem(SELECTED_CONTACT_ID_KEY);
  },

  async removeSelectedContactId(): Promise<void> {
    await AsyncStorage.removeItem(SELECTED_CONTACT_ID_KEY);
  },

  // Stay Logged In preference
  async saveStayLoggedIn(stay: boolean): Promise<void> {
    await AsyncStorage.setItem(STAY_LOGGED_IN_KEY, JSON.stringify(stay));
  },

  async getStayLoggedIn(): Promise<boolean> {
    const val = await AsyncStorage.getItem(STAY_LOGGED_IN_KEY);
    return val === 'true'; // Default to false if not set
  },

  // Session expiry (ms timestamp matching sessionExpires token claim)
  async saveSessionExpires(expiry: number): Promise<void> {
    await AsyncStorage.setItem(SESSION_EXPIRES_KEY, String(expiry));
  },

  async getSessionExpires(): Promise<number | null> {
    const val = await AsyncStorage.getItem(SESSION_EXPIRES_KEY);
    return val ? Number(val) : null;
  },

  // The signed-in member's studio look (utils/tenantTheme.ts TenantBrand) —
  // persisted so a cold start opens in the studio's colors. Cleared with auth.
  async saveTenantBrand(brand: object): Promise<void> {
    await AsyncStorage.setItem(TENANT_BRAND_KEY, JSON.stringify(brand));
  },

  async getTenantBrand<T extends object = Record<string, unknown>>(): Promise<T | null> {
    const val = await AsyncStorage.getItem(TENANT_BRAND_KEY);
    if (!val) return null;
    try {
      const parsed = JSON.parse(val);
      return parsed && typeof parsed === 'object' ? (parsed as T) : null;
    } catch {
      return null;
    }
  },

  async removeTenantBrand(): Promise<void> {
    await AsyncStorage.removeItem(TENANT_BRAND_KEY);
  },

  // Clear all auth data
  async clearAuth(): Promise<void> {
    await AsyncStorage.multiRemove([
      EMAIL_KEY,
      CODE_ID_KEY,
      SELECTED_CONTACT_ID_KEY,
      STAY_LOGGED_IN_KEY,
      SESSION_EXPIRES_KEY,
      TENANT_BRAND_KEY,
    ]);
  }
};
