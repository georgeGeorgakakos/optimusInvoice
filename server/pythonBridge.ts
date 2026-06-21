import { spawn } from "child_process";
import path from "path";

const PYTHON_DIR = path.join(__dirname, "python");

export interface ExtractedInvoiceData {
  supplier_name?: string;
  supplier_tax_id?: string;
  invoice_number?: string;
  invoice_date?: string;
  total_amount?: string;
  currency?: string;
  line_items: Array<{
    supplier_code?: string;
    description?: string;
    quantity?: string;
    unit_price?: string;
    discount1?: string;
    discount2?: string;
    discount3?: string;
    net_amount?: string;
    vat_rate?: string;
  }>;
}

export interface ProductMatch {
  erp_code: string;
  supplier_code: string;
  description?: string;
  confidence: number;
  match_type: string;
}

/**
 * Extract invoice data from PDF file
 */
export async function extractInvoiceData(pdfPath: string): Promise<ExtractedInvoiceData> {
  return new Promise((resolve, reject) => {
    const python = spawn("python3", [
      path.join(PYTHON_DIR, "invoice_extractor_advanced.py"),
      pdfPath
    ]);

    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Invoice extraction failed: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (error) {
        reject(new Error(`Failed to parse extraction result: ${error}`));
      }
    });
  });
}

/**
 * Find product matches using ML matcher
 */
export async function findProductMatches(
  supplierId: string,
  supplierCode: string,
  description: string,
  price?: string
): Promise<ProductMatch[]> {
  return new Promise((resolve, reject) => {
    const python = spawn("python3", [
      "-c",
      `
import sys
import json
sys.path.insert(0, '${PYTHON_DIR}')
from ml_product_matcher_v2 import MLProductMatcherV2

matcher = MLProductMatcherV2()
matches = matcher.find_matches(
    supplier_id='${supplierId}',
    supplier_code='${supplierCode}',
    description='${description}',
    price=${price ? parseFloat(price) : 'None'}
)
print(json.dumps(matches))
      `
    ]);

    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Product matching failed: ${stderr}`));
        return;
      }

      try {
        const matches = JSON.parse(stdout);
        resolve(matches);
      } catch (error) {
        reject(new Error(`Failed to parse matching result: ${error}`));
      }
    });
  });
}

/**
 * Record user confirmation for learning
 */
export async function recordConfirmation(
  supplierId: string,
  supplierCode: string,
  erpCode: string,
  description: string,
  price?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const python = spawn("python3", [
      "-c",
      `
import sys
sys.path.insert(0, '${PYTHON_DIR}')
from ml_product_matcher_v2 import MLProductMatcherV2

matcher = MLProductMatcherV2()
matcher.record_confirmation(
    supplier_id='${supplierId}',
    supplier_code='${supplierCode}',
    erp_code='${erpCode}',
    description='${description}',
    price=${price ? parseFloat(price) : 'None'}
)
print('OK')
      `
    ]);

    let stderr = "";

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Record confirmation failed: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Get learned rules for a supplier
 */
export async function getLearnedRules(supplierId?: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const supplierFilter = supplierId ? `supplier_id='${supplierId}'` : "";
    
    const python = spawn("python3", [
      "-c",
      `
import sys
import json
sys.path.insert(0, '${PYTHON_DIR}')
from ml_product_matcher_v2 import MLProductMatcherV2

matcher = MLProductMatcherV2()
rules = matcher.rule_engine.get_applicable_rules(${supplierFilter})
rules_data = [
    {
        'rule_type': r.rule_type,
        'pattern': r.pattern,
        'confidence': r.confidence,
        'usage_count': r.usage_count,
        'examples': r.examples
    }
    for r in rules
]
print(json.dumps(rules_data))
      `
    ]);

    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Get rules failed: ${stderr}`));
        return;
      }

      try {
        const rules = JSON.parse(stdout);
        resolve(rules);
      } catch (error) {
        reject(new Error(`Failed to parse rules: ${error}`));
      }
    });
  });
}

/**
 * Test Softone API connection
 */
export async function testSoftoneConnection(config: {
  apiUrl: string;
  username: string;
  password: string;
  clientId: string;
  appId: string;
  company: string;
  branch: string;
  module: string;
  refId: string;
}): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve, reject) => {
    const python = spawn("python3", [
      "-c",
      `
import sys
import json
sys.path.insert(0, '${PYTHON_DIR}')
from softone_api_client import SoftoneAPIClient

try:
    client = SoftoneAPIClient(
        api_url='${config.apiUrl}',
        username='${config.username}',
        password='${config.password}',
        client_id='${config.clientId}',
        app_id='${config.appId}',
        company='${config.company}',
        branch='${config.branch}',
        module='${config.module}',
        ref_id='${config.refId}'
    )
    
    # Try to login
    session_id = client.login()
    if session_id:
        print(json.dumps({'success': True, 'message': 'Connection successful'}))
    else:
        print(json.dumps({'success': False, 'message': 'Login failed'}))
except Exception as e:
    print(json.dumps({'success': False, 'message': str(e)}))
      `
    ]);

    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("close", (code) => {
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (error) {
        resolve({ success: false, message: `Test failed: ${stderr}` });
      }
    });
  });
}
