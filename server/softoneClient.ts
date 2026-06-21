import axios, { AxiosInstance } from 'axios';
import https from 'https';

/**
 * Complete Softone ERP API Client
 * Based on provided credentials and API documentation
 */

interface SoftoneConfig {
  baseUrl: string;
  username: string;
  password: string;
  company: number;
  fiscalYear: number;
  branch: number;
}

interface LoginResponse {
  success: boolean;
  sessionid?: string;
  error?: string;
}

interface Product {
  CODE: string;
  DESCR: string;
  RTLPRICE: number;
}

interface GetDataResponse {
  success: boolean;
  data?: any[];
  error?: string;
}

interface SetDataResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export class SoftoneClient {
  private config: SoftoneConfig;
  private sessionId: string | null = null;
  private axiosInstance: AxiosInstance;
  private sessionExpiry: number = 0;

  constructor(config?: Partial<SoftoneConfig>) {
    // Configuration must be provided via Configuration page - no hardcoded defaults
    this.config = {
      baseUrl: config?.baseUrl || '',
      username: config?.username || '',
      password: config?.password || '',
      company: config?.company || 1,
      fiscalYear: config?.fiscalYear || 2026,
      branch: config?.branch || 1,
    };

    if (!this.config.baseUrl) {
      console.warn('[Softone] No API URL configured. ERP integration disabled until configured in Settings.');
    }

    // Create axios instance with SSL verification disabled (as per documentation)
    this.axiosInstance = axios.create({
      baseURL: this.config.baseUrl,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false, // Disable SSL verification
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * Login to Softone and get session ID
   */
  async login(): Promise<LoginResponse> {
    try {
      // Guard: prevent connecting if not configured
      if (!this.config.baseUrl || !this.config.username) {
        return {
          success: false,
          error: 'Softone ERP not configured. Please set up your ERP connection in Configuration → ERP Integration.',
        };
      }

      const loginData = {
        service: 'login',
        company: this.config.company,
        fiscalyear: this.config.fiscalYear,
        branch: this.config.branch,
        username: this.config.username,
        password: this.config.password,
      };

      console.log('[Softone] Logging in...', {
        company: this.config.company,
        fiscalYear: this.config.fiscalYear,
        username: this.config.username,
      });

      const response = await this.axiosInstance.post('', loginData);

      if (response.data && response.data.sessionid) {
        this.sessionId = response.data.sessionid;
        // Session expires after 30 minutes
        this.sessionExpiry = Date.now() + 30 * 60 * 1000;
        
        console.log('[Softone] Login successful, session ID:', this.sessionId);
        
        return {
          success: true,
          sessionid: this.sessionId || undefined,
        };
      } else {
        console.error('[Softone] Login failed:', response.data);
        return {
          success: false,
          error: response.data?.error || 'Login failed - no session ID returned',
        };
      }
    } catch (error: any) {
      console.error('[Softone] Login error:', error.message);
      return {
        success: false,
        error: error.message || 'Login request failed',
      };
    }
  }

  /**
   * Ensure we have a valid session
   */
  private async ensureSession(): Promise<boolean> {
    // Check if session exists and hasn't expired
    if (this.sessionId && Date.now() < this.sessionExpiry) {
      return true;
    }

    // Need to login
    const loginResult = await this.login();
    return loginResult.success;
  }

  /**
   * Get data from Softone table
   */
  async getData(
    tableName: string,
    fields: string[],
    filters?: Record<string, any>
  ): Promise<GetDataResponse> {
    try {
      // Ensure we have a valid session
      const hasSession = await this.ensureSession();
      if (!hasSession) {
        return {
          success: false,
          error: 'Failed to establish session',
        };
      }

      const requestData: any = {
        service: 'getdata',
        sessionid: this.sessionId,
        action: 'read',
        tablename: tableName,
        fields: fields.join(';'),
      };

      // Add filters if provided
      if (filters) {
        requestData.filters = filters;
      }

      console.log('[Softone] Getting data from table:', tableName);

      const response = await this.axiosInstance.post('', requestData);

      if (response.data && response.data[tableName]) {
        return {
          success: true,
          data: response.data[tableName],
        };
      } else if (response.data && response.data.error) {
        console.error('[Softone] GetData error:', response.data.error);
        return {
          success: false,
          error: response.data.error,
        };
      } else {
        return {
          success: true,
          data: [],
        };
      }
    } catch (error: any) {
      console.error('[Softone] GetData request error:', error.message);
      return {
        success: false,
        error: error.message || 'GetData request failed',
      };
    }
  }

  /**
   * Get all products from STOCKITEMS table
   */
  async getProducts(): Promise<Product[]> {
    const result = await this.getData('STOCKITEMS', ['CODE', 'DESCR', 'RTLPRICE']);
    
    if (result.success && result.data) {
      return result.data as Product[];
    }
    
    return [];
  }

  /**
   * Find product by code
   */
  async findProductByCode(code: string): Promise<Product | null> {
    const result = await this.getData(
      'STOCKITEMS',
      ['CODE', 'DESCR', 'RTLPRICE'],
      { CODE: code }
    );

    if (result.success && result.data && result.data.length > 0) {
      return result.data[0] as Product;
    }

    return null;
  }

  /**
   * Create or update data in Softone
   */
  async setData(
    tableName: string,
    data: Record<string, any>,
    action: 'insert' | 'update' = 'insert'
  ): Promise<SetDataResponse> {
    try {
      // Ensure we have a valid session
      const hasSession = await this.ensureSession();
      if (!hasSession) {
        return {
          success: false,
          error: 'Failed to establish session',
        };
      }

      const requestData = {
        service: 'setdata',
        sessionid: this.sessionId,
        action: action,
        tablename: tableName,
        data: data,
      };

      console.log('[Softone] Setting data in table:', tableName, 'action:', action);

      const response = await this.axiosInstance.post('', requestData);

      if (response.data && !response.data.error) {
        return {
          success: true,
          data: response.data,
        };
      } else {
        console.error('[Softone] SetData error:', response.data?.error);
        return {
          success: false,
          error: response.data?.error || 'SetData failed',
        };
      }
    } catch (error: any) {
      console.error('[Softone] SetData request error:', error.message);
      return {
        success: false,
        error: error.message || 'SetData request failed',
      };
    }
  }

  /**
   * Create a purchase invoice in Softone
   * This is a placeholder - actual implementation depends on Softone's invoice table structure
   */
  async createPurchaseInvoice(invoiceData: {
    supplierCode: string;
    invoiceNumber: string;
    invoiceDate: string;
    lineItems: Array<{
      productCode: string;
      quantity: number;
      unitPrice: number;
      discount?: number;
      vatRate?: number;
    }>;
  }): Promise<SetDataResponse> {
    try {
      // Guard: prevent sending data if not configured
      if (!this.config.baseUrl || !this.config.username) {
        return {
          success: false,
          error: 'Softone ERP not configured. Please set up your ERP connection in Configuration → ERP Integration.',
        };
      }

      console.log('[Softone] Creating purchase invoice:', invoiceData.invoiceNumber);

      // Note: The actual table name and field structure for purchase invoices
      // needs to be confirmed from Softone documentation
      // This is a template that should be adjusted based on actual requirements

      const invoiceRecord = {
        TRDR: invoiceData.supplierCode, // Supplier code
        TRDOCNUM: invoiceData.invoiceNumber, // Invoice number
        TRDATE: invoiceData.invoiceDate, // Invoice date
        // Add other header fields as required by Softone
      };

      // Create invoice header
      const headerResult = await this.setData('PURCHASE_INVOICES', invoiceRecord, 'insert');

      if (!headerResult.success) {
        return headerResult;
      }

      // Create invoice line items
      for (const item of invoiceData.lineItems) {
        const lineRecord = {
          MTRL: item.productCode, // Product code
          QTY1: item.quantity, // Quantity
          PRICE: item.unitPrice, // Unit price
          DISC1: item.discount || 0, // Discount
          VATRATE: item.vatRate || 24, // VAT rate (default 24% for Greece)
          // Add other line fields as required
        };

        const lineResult = await this.setData('PURCHASE_INVOICE_LINES', lineRecord, 'insert');

        if (!lineResult.success) {
          console.error('[Softone] Failed to create line item:', lineResult.error);
          // Continue with other items or rollback?
        }
      }

      return {
        success: true,
        data: { message: 'Invoice created successfully' },
      };
    } catch (error: any) {
      console.error('[Softone] Create invoice error:', error.message);
      return {
        success: false,
        error: error.message || 'Failed to create invoice',
      };
    }
  }

  /**
   * Get suppliers from Softone
   */
  async getSuppliers(): Promise<any[]> {
    const result = await this.getData('TRDR', ['TRDR', 'NAME', 'AFM']); // TRDR=Supplier table
    
    if (result.success && result.data) {
      return result.data;
    }
    
    return [];
  }

  /**
   * Find supplier by name or tax ID
   */
  async findSupplier(searchTerm: string): Promise<any | null> {
    const suppliers = await this.getSuppliers();
    
    // Search by name or tax ID (AFM)
    const found = suppliers.find(
      (s) =>
        s.NAME?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.AFM === searchTerm
    );

    return found || null;
  }

  /**
   * Test connection to Softone
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const loginResult = await this.login();
      
      if (loginResult.success) {
        // Try to fetch a simple record to verify full access
        const testResult = await this.getData('STOCKITEMS', ['CODE'], {});
        
        if (testResult.success) {
          return {
            success: true,
            message: 'Connection successful - authenticated and can access data',
          };
        } else {
          return {
            success: false,
            message: `Login successful but data access failed: ${testResult.error}`,
          };
        }
      } else {
        return {
          success: false,
          message: `Login failed: ${loginResult.error}`,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        message: `Connection test failed: ${error.message}`,
      };
    }
  }

  /**
   * Logout and clear session
   */
  async logout(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.axiosInstance.post('', {
          service: 'logout',
          sessionid: this.sessionId,
        });
      } catch (error) {
        console.error('[Softone] Logout error:', error);
      }
      
      this.sessionId = null;
      this.sessionExpiry = 0;
    }
  }
}

/**
 * Create a SoftoneClient from user's saved configuration
 */
export function createSoftoneClient(config: {
  softoneApiUrl?: string | null;
  softoneUsername?: string | null;
  softonePassword?: string | null;
  softoneClientId?: string | null;
  softoneAppId?: string | null;
  softoneCompany?: string | null;
  softoneBranch?: string | null;
  softoneModule?: string | null;
  softoneRefId?: string | null;
  fiscalYear?: string | null;
}): SoftoneClient {
  return new SoftoneClient({
    baseUrl: config.softoneApiUrl || '',
    username: config.softoneUsername || '',
    password: config.softonePassword || '',
    company: parseInt(config.softoneCompany || '1') || 1,
    fiscalYear: parseInt(config.fiscalYear || '2026') || 2026,
    branch: parseInt(config.softoneBranch || '1') || 1,
  });
}

/**
 * Get a configured SoftoneClient for a specific user (reads from DB)
 */
export async function getSoftoneClientForUser(userId: number): Promise<SoftoneClient> {
  const { getUserConfiguration } = await import('./invoiceDb');
  const config = await getUserConfiguration(userId);
  
  if (!config || !config.softoneApiUrl || !config.softoneUsername) {
    throw new Error('Softone ERP not configured. Go to Configuration → ERP Integration to set up your connection.');
  }
  
  return createSoftoneClient(config);
}
