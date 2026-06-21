#!/usr/bin/env python3
"""
Softone ERP API Client
Handles authentication, session management, and API communication
"""

import requests
import json
import time
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class SoftoneAPIClient:
    """Client for Softone ERP REST API"""
    
    def __init__(self, api_url: str, company_id: int, branch_id: int, fiscal_year: int = 2026):
        """
        Initialize Softone API client
        
        Args:
            api_url: Base URL of Softone API (e.g., http://localhost:8080/api)
            company_id: Company ID in Softone
            branch_id: Branch ID in Softone
            fiscal_year: Fiscal year (default 2026)
        """
        self.api_url = api_url.rstrip('/')
        self.company_id = company_id
        self.branch_id = branch_id
        self.fiscal_year = fiscal_year
        
        self.sessionid = None
        self.session_created = None
        self.session_timeout = 30 * 60  # 30 minutes in seconds
        
        self.username = None
        self.password = None
        
        # HTTP session for connection pooling
        self.http_session = requests.Session()
    
    def login(self, username: str, password: str) -> bool:
        """
        Authenticate with Softone API
        
        Args:
            username: Softone username
            password: Softone password
            
        Returns:
            True if authentication successful, False otherwise
        """
        try:
            self.username = username
            self.password = password
            
            payload = {
                "service": "login",
                "company": self.company_id,
                "fiscalyear": self.fiscal_year,
                "branch": self.branch_id,
                "username": username,
                "password": password
            }
            
            logger.info(f"Authenticating user: {username}")
            response = self.http_session.post(
                f"{self.api_url}/login",
                json=payload,
                timeout=10
            )
            
            if response.status_code != 200:
                logger.error(f"Login failed with status code {response.status_code}")
                return False
            
            data = response.json()
            
            if not data.get('success', False):
                error_msg = data.get('errormessage', 'Unknown error')
                logger.error(f"Login failed: {error_msg}")
                return False
            
            self.sessionid = data.get('logininfo', {}).get('sessionid')
            self.session_created = datetime.now()
            
            if self.sessionid:
                logger.info(f"Successfully authenticated. Session ID: {self.sessionid[:20]}...")
                return True
            else:
                logger.error("No session ID returned from login")
                return False
                
        except requests.exceptions.RequestException as e:
            logger.error(f"Request error during login: {e}")
            return False
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error during login: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error during login: {e}")
            return False
    
    def is_session_valid(self) -> bool:
        """Check if current session is still valid"""
        if not self.sessionid or not self.session_created:
            return False
        
        elapsed = (datetime.now() - self.session_created).total_seconds()
        return elapsed < self.session_timeout
    
    def ensure_session(self) -> bool:
        """Ensure valid session exists, re-authenticate if needed"""
        if self.is_session_valid():
            return True
        
        if self.username and self.password:
            logger.info("Session expired, re-authenticating...")
            return self.login(self.username, self.password)
        
        logger.error("No valid session and no credentials available")
        return False
    
    def get_data(self, tablename: str, fields: Optional[str] = None, 
                 filters: Optional[List[Dict]] = None, orderby: Optional[str] = None,
                 action: str = "read") -> Optional[Dict]:
        """
        Retrieve data from Softone
        
        Args:
            tablename: Name of the table to query
            fields: Comma-separated field names to retrieve
            filters: List of filter conditions
            orderby: Sort order specification
            action: "read" or "info"
            
        Returns:
            Response data or None if error
        """
        if not self.ensure_session():
            logger.error("Cannot retrieve data: no valid session")
            return None
        
        try:
            payload = {
                "service": "getdata",
                "sessionid": self.sessionid,
                "action": action,
                "tablename": tablename
            }
            
            if fields:
                payload["fields"] = fields
            
            if filters:
                payload["filters"] = filters
            
            if orderby:
                payload["orderby"] = orderby
            
            logger.debug(f"Querying table: {tablename}")
            response = self.http_session.post(
                f"{self.api_url}/getdata",
                json=payload,
                timeout=30
            )
            
            if response.status_code != 200:
                logger.error(f"Query failed with status code {response.status_code}")
                return None
            
            data = response.json()
            
            if not data.get('success', False):
                error_msg = data.get('errormessage', 'Unknown error')
                logger.error(f"Query failed: {error_msg}")
                return None
            
            logger.debug(f"Successfully retrieved data from {tablename}")
            return data
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Request error during getdata: {e}")
            return None
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error during getdata: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error during getdata: {e}")
            return None
    
    def set_data(self, tablename: str, records: List[Dict], mode: str = "insert",
                 action: str = "write", async_mode: bool = False) -> Optional[Dict]:
        """
        Create, update, or delete records in Softone
        
        Args:
            tablename: Name of the table
            records: List of record dictionaries
            mode: "insert", "update", or "insuPd"
            action: "write" or "delete"
            async_mode: If True, request is processed asynchronously
            
        Returns:
            Response data or None if error
        """
        if not self.ensure_session():
            logger.error("Cannot set data: no valid session")
            return None
        
        try:
            payload = {
                "service": "setdata",
                "sessionid": self.sessionid,
                "action": action,
                "mode": mode,
                "tablename": tablename,
                "asynched": async_mode,
                tablename: records  # Add records with table name as key
            }
            
            logger.info(f"Writing {len(records)} record(s) to {tablename} (mode: {mode})")
            response = self.http_session.post(
                f"{self.api_url}/setdata",
                json=payload,
                timeout=60
            )
            
            if response.status_code != 200:
                logger.error(f"Write failed with status code {response.status_code}")
                return None
            
            data = response.json()
            
            if not data.get('success', False):
                error_msg = data.get('errormessage', 'Unknown error')
                logger.error(f"Write failed: {error_msg}")
                return None
            
            logger.info(f"Successfully wrote data to {tablename}")
            return data
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Request error during setdata: {e}")
            return None
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error during setdata: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error during setdata: {e}")
            return None
    
    def find_supplier(self, supplier_name: str = None, tax_id: str = None) -> Optional[Dict]:
        """
        Find supplier by name or tax ID
        
        Args:
            supplier_name: Supplier company name
            tax_id: Supplier tax ID (ΑΦΜ)
            
        Returns:
            Supplier record or None if not found
        """
        filters = []
        
        if supplier_name:
            filters.append({
                "field": "COMPANY",
                "operator": "like",
                "value": supplier_name
            })
        
        if tax_id:
            filters.append({
                "field": "TAXID",
                "operator": "equal",
                "value": tax_id
            })
        
        if not filters:
            logger.warning("No supplier search criteria provided")
            return None
        
        # Combine filters with AND if multiple
        if len(filters) > 1:
            combined_filter = {
                "group": "and",
                "filters": filters
            }
            filter_list = [combined_filter]
        else:
            filter_list = filters
        
        result = self.get_data(
            tablename="suppliers",
            fields="ID;COMPANY;TAXID;ADDRESS",
            filters=filter_list,
            action="read"
        )
        
        if result and result.get('suppliers'):
            return result['suppliers'][0]
        
        logger.warning(f"Supplier not found: {supplier_name or tax_id}")
        return None
    
    def find_product(self, product_code: str = None, description: str = None) -> Optional[Dict]:
        """
        Find product by code or description
        
        Args:
            product_code: Product SKU/code
            description: Product description
            
        Returns:
            Product record or None if not found
        """
        filters = []
        
        if product_code:
            filters.append({
                "field": "CODE",
                "operator": "equal",
                "value": product_code
            })
        
        if description:
            filters.append({
                "field": "DESCR",
                "operator": "like",
                "value": description
            })
        
        if not filters:
            logger.warning("No product search criteria provided")
            return None
        
        # Combine filters with AND if multiple
        if len(filters) > 1:
            combined_filter = {
                "group": "and",
                "filters": filters
            }
            filter_list = [combined_filter]
        else:
            filter_list = filters
        
        result = self.get_data(
            tablename="stockitems",
            fields="ID;CODE;DESCR;VATID",
            filters=filter_list,
            action="read"
        )
        
        if result and result.get('stockitems'):
            return result['stockitems'][0]
        
        logger.warning(f"Product not found: {product_code or description}")
        return None
    
    def create_purchase_invoice(self, invoice_data: Dict, line_items: List[Dict]) -> Optional[Dict]:
        """
        Create a purchase invoice in Softone
        
        Args:
            invoice_data: Invoice header data
            line_items: List of line item records
            
        Returns:
            Response data or None if error
        """
        try:
            # Prepare invoice record
            invoice_record = {
                "HMERNIA": invoice_data.get('date'),
                "ARITHMOS": invoice_data.get('number'),
                "PROMSTHEFTIS": invoice_data.get('supplier_id'),
                "NOMISMA": invoice_data.get('currency', 'EUR'),
                "SKOPOS_DIAKINISIS": invoice_data.get('purpose', ''),
                "YPOKATASTIMA": invoice_data.get('branch_id', self.branch_id),
                "NOTES": invoice_data.get('notes', '')
            }
            
            # Prepare line items
            prepared_items = []
            for item in line_items:
                line_item = {
                    "KODIKOS_ANALITI": item.get('product_code'),
                    "PERIGRAFI": item.get('description'),
                    "MM": item.get('unit', 'TEM'),
                    "POSOTITA": item.get('quantity'),
                    "TIMI_MONADAS": item.get('unit_price'),
                    "EKPTOSI_1": item.get('discount_1', 0),
                    "EKPTOSI_2": item.get('discount_2', 0),
                    "EKPTOSI_3": item.get('discount_3', 0),
                    "AXIA": item.get('net_amount'),
                    "FPA_POSOSTO": item.get('vat_percent', 24)
                }
                prepared_items.append(line_item)
            
            # Create invoice with line items
            logger.info(f"Creating purchase invoice: {invoice_data.get('number')}")
            
            # First create the invoice header
            header_result = self.set_data(
                tablename="PARAST_AGORON",
                records=[invoice_record],
                mode="insert"
            )
            
            if not header_result:
                logger.error("Failed to create invoice header")
                return None
            
            # Then add line items
            items_result = self.set_data(
                tablename="PARAST_AGORON_LINES",
                records=prepared_items,
                mode="insert"
            )
            
            if not items_result:
                logger.error("Failed to create invoice line items")
                return None
            
            logger.info(f"Successfully created invoice: {invoice_data.get('number')}")
            return {"header": header_result, "items": items_result}
            
        except Exception as e:
            logger.error(f"Error creating purchase invoice: {e}")
            return None
    
    def close(self):
        """Close HTTP session"""
        self.http_session.close()
        logger.info("API client session closed")


def main():
    """Example usage"""
    # Configuration (update with your actual values)
    API_URL = "http://localhost:8080/api"
    COMPANY_ID = 1
    BRANCH_ID = 1
    USERNAME = "admin"
    PASSWORD = ""
    
    # Create client
    client = SoftoneAPIClient(API_URL, COMPANY_ID, BRANCH_ID, fiscal_year=2026)
    
    # Login
    if not client.login(USERNAME, PASSWORD):
        logger.error("Failed to login")
        return
    
    # Example: Find a supplier
    supplier = client.find_supplier(supplier_name="FF GROUP")
    if supplier:
        logger.info(f"Found supplier: {supplier}")
    
    # Example: Find a product
    product = client.find_product(product_code="71628")
    if product:
        logger.info(f"Found product: {product}")
    
    # Close connection
    client.close()


if __name__ == "__main__":
    main()
