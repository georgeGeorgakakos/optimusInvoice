#!/usr/bin/env python3
"""
Enhanced ML Product Matcher with Automatic Rule Learning
Integrates rule learning engine for automatic pattern detection
"""

import json
import logging
from typing import Dict, List, Optional
from datetime import datetime, timedelta
from collections import defaultdict
import re

# Import rule learning engine
from rule_learning_engine import RuleLearningEngine, TransformationRule

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class MLProductMatcherV2:
    """Enhanced ML Product Matcher with automatic rule learning"""
    
    def __init__(self, knowledge_base_path: str = 'knowledge_base.json',
                 rules_file: str = 'transformation_rules.json'):
        self.knowledge_base_path = knowledge_base_path
        self.knowledge_base = self._load_knowledge_base()
        self.rule_engine = RuleLearningEngine(rules_file)
        self.confirmation_count = 0
    
    def _load_knowledge_base(self) -> Dict:
        """Load existing knowledge base"""
        try:
            with open(self.knowledge_base_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            logger.warning(f"Knowledge base not found: {self.knowledge_base_path}")
            return {'suppliers': {}, 'products': {}, 'mappings': {}}
        except Exception as e:
            logger.error(f"Error loading knowledge base: {e}")
            return {'suppliers': {}, 'products': {}, 'mappings': {}}
    
    def save_knowledge_base(self):
        """Save knowledge base to file"""
        try:
            with open(self.knowledge_base_path, 'w', encoding='utf-8') as f:
                json.dump(self.knowledge_base, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Error saving knowledge base: {e}")
    
    def find_matches(self, supplier_id: str, supplier_code: str, 
                    description: str = '', price: float = 0) -> List[Dict]:
        """
        Find product matches using ML + Rule Learning
        
        Returns list of matches with confidence scores
        """
        matches = []
        seen_codes = set()
        
        # 1. FIRST PRIORITY: Check exact mapping in knowledge base
        exact_match = self._check_exact_mapping(supplier_id, supplier_code)
        if exact_match:
            matches.append({
                'erp_code': exact_match['erp_code'],
                'description': exact_match.get('description', ''),
                'confidence': 100,
                'match_type': 'exact_mapping',
                'frequency': exact_match.get('frequency', 1),
                'last_used': exact_match.get('last_used', ''),
                'avg_price': exact_match.get('avg_price', 0),
                'source': 'Historical data'
            })
            seen_codes.add(exact_match['erp_code'])
        
        # 2. SECOND PRIORITY: Apply learned transformation rules
        rule_matches = self._apply_transformation_rules(supplier_id, supplier_code)
        for erp_code, rule, rule_confidence in rule_matches:
            if erp_code not in seen_codes:
                # Verify this code exists in ERP (from knowledge base)
                product_info = self._get_product_info(erp_code)
                if product_info:
                    matches.append({
                        'erp_code': erp_code,
                        'description': product_info.get('description', ''),
                        'confidence': int(rule_confidence * 100),
                        'match_type': 'transformation_rule',
                        'rule': rule,
                        'rule_explanation': self.rule_engine.explain_transformation(
                            supplier_code, erp_code, rule
                        ),
                        'frequency': product_info.get('frequency', 0),
                        'last_used': product_info.get('last_used', ''),
                        'avg_price': product_info.get('avg_price', 0),
                        'source': f'Rule: {rule.rule_type}'
                    })
                    seen_codes.add(erp_code)
        
        # 3. THIRD PRIORITY: Fuzzy code matching
        fuzzy_matches = self._fuzzy_code_match(supplier_code)
        for match in fuzzy_matches:
            if match['erp_code'] not in seen_codes:
                matches.append(match)
                seen_codes.add(match['erp_code'])
        
        # 4. FOURTH PRIORITY: Description matching
        if description:
            desc_matches = self._description_match(description)
            for match in desc_matches:
                if match['erp_code'] not in seen_codes:
                    matches.append(match)
                    seen_codes.add(match['erp_code'])
        
        # 5. Price validation (boost confidence for price matches)
        if price > 0:
            for match in matches:
                if match.get('avg_price', 0) > 0:
                    price_diff_pct = abs(match['avg_price'] - price) / match['avg_price'] * 100
                    if price_diff_pct < 10:
                        # Price matches within 10% - boost confidence
                        match['confidence'] = min(100, match['confidence'] + 10)
                        match['price_match'] = True
                    elif price_diff_pct > 30:
                        # Price differs significantly - reduce confidence
                        match['confidence'] = max(0, match['confidence'] - 15)
                        match['price_mismatch'] = True
        
        # Sort by confidence
        matches.sort(key=lambda x: x['confidence'], reverse=True)
        
        # Return top 10
        return matches[:10]
    
    def _check_exact_mapping(self, supplier_id: str, supplier_code: str) -> Optional[Dict]:
        """Check for exact mapping in knowledge base"""
        mappings = self.knowledge_base.get('mappings', {})
        key = f"{supplier_id}:{supplier_code}"
        return mappings.get(key)
    
    def _apply_transformation_rules(self, supplier_id: str, supplier_code: str) -> List:
        """Apply learned transformation rules"""
        return self.rule_engine.apply_rules(supplier_id, supplier_code)
    
    def _get_product_info(self, erp_code: str) -> Optional[Dict]:
        """Get product information from knowledge base"""
        products = self.knowledge_base.get('products', {})
        return products.get(erp_code)
    
    def _fuzzy_code_match(self, supplier_code: str) -> List[Dict]:
        """Fuzzy matching on product codes"""
        matches = []
        products = self.knowledge_base.get('products', {})
        
        # Generate code variations
        variations = self._generate_code_variations(supplier_code)
        
        for erp_code, product_info in products.items():
            # Check exact variation match
            if erp_code in variations:
                confidence = 85
                matches.append({
                    'erp_code': erp_code,
                    'description': product_info.get('description', ''),
                    'confidence': confidence,
                    'match_type': 'fuzzy_code',
                    'frequency': product_info.get('frequency', 0),
                    'last_used': product_info.get('last_used', ''),
                    'avg_price': product_info.get('avg_price', 0),
                    'source': 'Code variation'
                })
            
            # Check similarity
            similarity = self._calculate_code_similarity(supplier_code, erp_code)
            if similarity > 0.7:
                confidence = int(similarity * 80)
                matches.append({
                    'erp_code': erp_code,
                    'description': product_info.get('description', ''),
                    'confidence': confidence,
                    'match_type': 'fuzzy_code',
                    'frequency': product_info.get('frequency', 0),
                    'last_used': product_info.get('last_used', ''),
                    'avg_price': product_info.get('avg_price', 0),
                    'source': f'Code similarity: {similarity:.0%}'
                })
        
        return matches
    
    def _generate_code_variations(self, code: str) -> List[str]:
        """Generate variations of a product code"""
        variations = [code]
        
        # Remove separators
        for sep in ['-', '_', '.', ' ', '/']:
            if sep in code:
                variations.append(code.replace(sep, ''))
        
        # Extract numbers only
        numbers = ''.join(filter(str.isdigit, code))
        if numbers:
            variations.append(numbers)
        
        # Remove common prefixes/suffixes
        for suffix in ['-A', '-B', '-C', 'A', 'B', 'C']:
            if code.endswith(suffix):
                variations.append(code[:-len(suffix)])
        
        return list(set(variations))
    
    def _calculate_code_similarity(self, code1: str, code2: str) -> float:
        """Calculate similarity between two codes"""
        from difflib import SequenceMatcher
        return SequenceMatcher(None, code1.lower(), code2.lower()).ratio()
    
    def _description_match(self, description: str) -> List[Dict]:
        """Match based on description similarity"""
        matches = []
        products = self.knowledge_base.get('products', {})
        
        # Simple keyword matching
        desc_words = set(description.lower().split())
        
        for erp_code, product_info in products.items():
            product_desc = product_info.get('description', '')
            if not product_desc:
                continue
            
            product_words = set(product_desc.lower().split())
            
            # Jaccard similarity
            intersection = desc_words & product_words
            union = desc_words | product_words
            
            if len(union) > 0:
                similarity = len(intersection) / len(union)
                
                if similarity > 0.3:
                    confidence = int(similarity * 70)
                    matches.append({
                        'erp_code': erp_code,
                        'description': product_desc,
                        'confidence': confidence,
                        'match_type': 'description',
                        'frequency': product_info.get('frequency', 0),
                        'last_used': product_info.get('last_used', ''),
                        'avg_price': product_info.get('avg_price', 0),
                        'source': f'Description similarity: {similarity:.0%}'
                    })
        
        return matches
    
    def record_confirmation(self, supplier_id: str, supplier_code: str, 
                          erp_code: str, description: str = '', price: float = 0):
        """
        Record user confirmation and learn from it
        
        This is where the magic happens - automatic rule learning!
        """
        self.confirmation_count += 1
        
        # 1. Record in knowledge base (exact mapping)
        mappings = self.knowledge_base.setdefault('mappings', {})
        key = f"{supplier_id}:{supplier_code}"
        
        if key in mappings:
            # Update existing mapping
            mappings[key]['frequency'] += 1
            mappings[key]['last_used'] = datetime.now().isoformat()
            if price > 0:
                # Update average price
                old_avg = mappings[key].get('avg_price', price)
                old_freq = mappings[key]['frequency'] - 1
                new_avg = (old_avg * old_freq + price) / mappings[key]['frequency']
                mappings[key]['avg_price'] = new_avg
        else:
            # Create new mapping
            mappings[key] = {
                'supplier_id': supplier_id,
                'supplier_code': supplier_code,
                'erp_code': erp_code,
                'description': description,
                'frequency': 1,
                'first_seen': datetime.now().isoformat(),
                'last_used': datetime.now().isoformat(),
                'avg_price': price
            }
        
        # 2. Update product information
        products = self.knowledge_base.setdefault('products', {})
        if erp_code not in products:
            products[erp_code] = {
                'erp_code': erp_code,
                'description': description,
                'frequency': 1,
                'first_seen': datetime.now().isoformat(),
                'last_used': datetime.now().isoformat(),
                'avg_price': price
            }
        else:
            products[erp_code]['frequency'] += 1
            products[erp_code]['last_used'] = datetime.now().isoformat()
        
        # 3. **AUTOMATIC RULE LEARNING** - This is the key feature!
        self.rule_engine.record_correction(supplier_id, supplier_code, erp_code)
        
        # 4. Save everything
        self.save_knowledge_base()
        
        logger.info(f"✓ Recorded confirmation: {supplier_code} → {erp_code}")
        logger.info(f"  Total confirmations: {self.confirmation_count}")
        
        # 5. Check if we learned new rules
        applicable_rules = self.rule_engine.get_applicable_rules(supplier_id)
        logger.info(f"  Applicable rules for supplier: {len(applicable_rules)}")
    
    def get_statistics(self) -> Dict:
        """Get comprehensive statistics"""
        mappings = self.knowledge_base.get('mappings', {})
        products = self.knowledge_base.get('products', {})
        
        # Group by supplier
        supplier_stats = defaultdict(int)
        for key in mappings.keys():
            supplier_id = key.split(':')[0]
            supplier_stats[supplier_id] += 1
        
        # Rule engine statistics
        rule_stats = self.rule_engine.get_statistics()
        
        return {
            'total_mappings': len(mappings),
            'total_products': len(products),
            'suppliers_with_mappings': len(supplier_stats),
            'confirmations_this_session': self.confirmation_count,
            'rule_statistics': rule_stats
        }


if __name__ == '__main__':
    # Test the enhanced matcher
    print("=== Testing Enhanced ML Product Matcher with Rule Learning ===\n")
    
    matcher = MLProductMatcherV2('test_kb.json', 'test_rules.json')
    
    # Simulate scenario: Supplier codes need prefix "317-"
    print("SCENARIO: Supplier uses codes without prefix, ERP has prefix '317-'\n")
    
    corrections = [
        ("101", "74245", "317-74245", "PRODUCT A", 10.50),
        ("101", "74333", "317-74333", "PRODUCT B", 12.00),
        ("101", "74677", "317-74677", "PRODUCT C", 8.75),
    ]
    
    print("=== User Makes 3 Corrections ===\n")
    for supplier_id, supplier_code, erp_code, desc, price in corrections:
        print(f"Correction: {supplier_code} → {erp_code}")
        matcher.record_confirmation(supplier_id, supplier_code, erp_code, desc, price)
        print()
    
    print("\n=== System Learned Rules ===\n")
    rules = matcher.rule_engine.get_applicable_rules("101")
    for rule in rules:
        print(rule)
    
    print("\n=== Testing New Product Code ===\n")
    test_code = "74810"
    print(f"New invoice has code: {test_code}")
    print("Searching for matches...\n")
    
    matches = matcher.find_matches("101", test_code, "PRODUCT D", 15.00)
    
    if matches:
        print(f"Found {len(matches)} matches:\n")
        for i, match in enumerate(matches[:3], 1):
            print(f"{i}. [{match['erp_code']}] {match.get('description', 'N/A')}")
            print(f"   Confidence: {match['confidence']}%")
            print(f"   Source: {match['source']}")
            if 'rule_explanation' in match:
                print(f"   Rule: {match['rule_explanation']}")
            print()
    
    print("\n=== Statistics ===\n")
    stats = matcher.get_statistics()
    for key, value in stats.items():
        if isinstance(value, dict):
            print(f"{key}:")
            for k, v in value.items():
                print(f"  {k}: {v}")
        else:
            print(f"{key}: {value}")
