#!/usr/bin/env python3
"""
Rule Learning Engine
Automatically detects patterns in user corrections and creates transformation rules
"""

import re
import json
import logging
from typing import Dict, List, Optional, Tuple
from collections import defaultdict, Counter
from datetime import datetime
from difflib import SequenceMatcher

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class TransformationRule:
    """Represents a learned transformation rule"""
    
    def __init__(self, rule_type: str, pattern: str, replacement: str, 
                 supplier_id: Optional[str] = None, confidence: float = 0.0):
        self.rule_type = rule_type  # suffix_removal, prefix_removal, character_replacement, etc.
        self.pattern = pattern
        self.replacement = replacement
        self.supplier_id = supplier_id  # None = applies to all suppliers
        self.confidence = confidence
        self.usage_count = 0
        self.success_count = 0
        self.created_at = datetime.now().isoformat()
        self.last_used = None
        self.examples = []  # List of (supplier_code, erp_code) examples
    
    def apply(self, supplier_code: str) -> Optional[str]:
        """Apply this rule to a supplier code"""
        try:
            if self.rule_type == 'prefix_addition':
                # Add prefix to supplier code
                return self.pattern + supplier_code
            
            elif self.rule_type == 'suffix_addition':
                # Add suffix to supplier code
                return supplier_code + self.pattern
            
            elif self.rule_type == 'suffix_removal':
                if supplier_code.endswith(self.pattern):
                    return supplier_code[:-len(self.pattern)]
            
            elif self.rule_type == 'prefix_removal':
                if supplier_code.startswith(self.pattern):
                    return supplier_code[len(self.pattern):]
            
            elif self.rule_type == 'character_replacement':
                return supplier_code.replace(self.pattern, self.replacement)
            
            elif self.rule_type == 'regex_replacement':
                return re.sub(self.pattern, self.replacement, supplier_code)
            
            elif self.rule_type == 'separator_removal':
                # Remove specific separators
                return supplier_code.replace(self.pattern, self.replacement)
            
            return None
        except Exception as e:
            logger.error(f"Error applying rule: {e}")
            return None
    
    def matches(self, supplier_code: str, erp_code: str) -> bool:
        """Check if this rule would correctly transform supplier_code to erp_code"""
        result = self.apply(supplier_code)
        return result == erp_code if result else False
    
    def record_usage(self, success: bool):
        """Record rule usage and success"""
        self.usage_count += 1
        if success:
            self.success_count += 1
        self.last_used = datetime.now().isoformat()
        self.confidence = self.success_count / self.usage_count if self.usage_count > 0 else 0
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for serialization"""
        return {
            'rule_type': self.rule_type,
            'pattern': self.pattern,
            'replacement': self.replacement,
            'supplier_id': self.supplier_id,
            'confidence': self.confidence,
            'usage_count': self.usage_count,
            'success_count': self.success_count,
            'created_at': self.created_at,
            'last_used': self.last_used,
            'examples': self.examples[:5]  # Keep only first 5 examples
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'TransformationRule':
        """Create from dictionary"""
        rule = cls(
            rule_type=data['rule_type'],
            pattern=data['pattern'],
            replacement=data['replacement'],
            supplier_id=data.get('supplier_id'),
            confidence=data.get('confidence', 0.0)
        )
        rule.usage_count = data.get('usage_count', 0)
        rule.success_count = data.get('success_count', 0)
        rule.created_at = data.get('created_at', datetime.now().isoformat())
        rule.last_used = data.get('last_used')
        rule.examples = data.get('examples', [])
        return rule
    
    def __repr__(self) -> str:
        scope = f"Supplier {self.supplier_id}" if self.supplier_id else "All suppliers"
        return f"<Rule {self.rule_type}: '{self.pattern}' → '{self.replacement}' ({scope}, {self.confidence:.0%} confidence)>"


class RuleLearningEngine:
    """Learns transformation rules from user corrections"""
    
    def __init__(self, rules_file: str = 'transformation_rules.json'):
        self.rules_file = rules_file
        self.rules: List[TransformationRule] = []
        self.correction_history: Dict[str, List[Tuple[str, str]]] = defaultdict(list)
        self.load_rules()
    
    def load_rules(self):
        """Load existing rules from file"""
        try:
            with open(self.rules_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                self.rules = [TransformationRule.from_dict(r) for r in data.get('rules', [])]
                self.correction_history = defaultdict(list, data.get('correction_history', {}))
            logger.info(f"Loaded {len(self.rules)} transformation rules")
        except FileNotFoundError:
            logger.info("No existing rules file found, starting fresh")
        except Exception as e:
            logger.error(f"Error loading rules: {e}")
    
    def save_rules(self):
        """Save rules to file"""
        try:
            data = {
                'rules': [r.to_dict() for r in self.rules],
                'correction_history': dict(self.correction_history),
                'last_updated': datetime.now().isoformat()
            }
            with open(self.rules_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            logger.info(f"Saved {len(self.rules)} transformation rules")
        except Exception as e:
            logger.error(f"Error saving rules: {e}")
    
    def record_correction(self, supplier_id: str, supplier_code: str, erp_code: str):
        """
        Record a user correction and learn from it
        
        Args:
            supplier_id: Supplier ID
            supplier_code: Original supplier product code
            erp_code: Correct ERP code (user's selection)
        """
        # Record in history
        key = f"{supplier_id}:{supplier_code}"
        self.correction_history[key].append((supplier_code, erp_code))
        
        logger.info(f"Recorded correction: {supplier_code} → {erp_code} (Supplier {supplier_id})")
        
        # Detect and create rules
        self._detect_and_create_rules(supplier_id, supplier_code, erp_code)
        
        # Check if we have enough data to generalize
        supplier_corrections = [
            (sc, ec) for k, corrections in self.correction_history.items()
            if k.startswith(f"{supplier_id}:")
            for sc, ec in corrections
        ]
        
        if len(supplier_corrections) >= 3:
            self._generalize_rules(supplier_id, supplier_corrections)
        
        self.save_rules()
    
    def _detect_and_create_rules(self, supplier_id: str, supplier_code: str, erp_code: str):
        """Detect patterns and create transformation rules"""
        
        # 1. Check for prefix addition (ERP has prefix that supplier doesn't)
        if erp_code.endswith(supplier_code) and len(erp_code) > len(supplier_code):
            # ERP code has additional prefix
            prefix = erp_code[:-len(supplier_code)]
            if prefix:
                self._add_or_update_rule(
                    rule_type='prefix_addition',
                    pattern=prefix,
                    replacement='',
                    supplier_id=supplier_id,
                    example=(supplier_code, erp_code)
                )
                logger.info(f"Learned prefix addition rule: add '{prefix}'")
        
        # 2. Check for suffix addition (ERP has suffix that supplier doesn't)
        if erp_code.endswith(supplier_code):
            # ERP code has additional suffix
            suffix = erp_code[len(supplier_code):]
            if suffix:
                self._add_or_update_rule(
                    rule_type='suffix_addition',
                    pattern=suffix,
                    replacement='',
                    supplier_id=supplier_id,
                    example=(supplier_code, erp_code)
                )
                logger.info(f"Learned suffix addition rule: add '{suffix}'")
        
        # 3. Check for suffix removal
        if supplier_code.startswith(erp_code):
            suffix = supplier_code[len(erp_code):]
            if suffix:
                self._add_or_update_rule(
                    rule_type='suffix_removal',
                    pattern=suffix,
                    replacement='',
                    supplier_id=supplier_id,
                    example=(supplier_code, erp_code)
                )
                logger.info(f"Learned suffix removal rule: remove '{suffix}'")
        
        # 4. Check for prefix removal
        if supplier_code.endswith(erp_code):
            prefix = supplier_code[:-len(erp_code)]
            if prefix:
                self._add_or_update_rule(
                    rule_type='prefix_removal',
                    pattern=prefix,
                    replacement='',
                    supplier_id=supplier_id,
                    example=(supplier_code, erp_code)
                )
                logger.info(f"Learned prefix removal rule: remove '{prefix}'")
        
        # 5. Check for character replacement
        if len(supplier_code) == len(erp_code):
            # Find differing characters
            diffs = [(i, supplier_code[i], erp_code[i]) 
                     for i in range(len(supplier_code)) 
                     if supplier_code[i] != erp_code[i]]
            
            if len(diffs) == 1:
                # Single character difference
                i, old_char, new_char = diffs[0]
                self._add_or_update_rule(
                    rule_type='character_replacement',
                    pattern=old_char,
                    replacement=new_char,
                    supplier_id=supplier_id,
                    example=(supplier_code, erp_code)
                )
                logger.info(f"Learned character replacement: '{old_char}' → '{new_char}'")
        
        # 6. Check for separator removal
        separators = ['-', '_', '.', ' ', '/']
        for sep in separators:
            if sep in supplier_code and sep not in erp_code:
                test_code = supplier_code.replace(sep, '')
                if test_code == erp_code:
                    self._add_or_update_rule(
                        rule_type='separator_removal',
                        pattern=sep,
                        replacement='',
                        supplier_id=supplier_id,
                        example=(supplier_code, erp_code)
                    )
                    logger.info(f"Learned separator removal: remove '{sep}'")
        
        # 7. Check for regex patterns (more complex)
        self._detect_regex_pattern(supplier_id, supplier_code, erp_code)
    
    def _detect_regex_pattern(self, supplier_id: str, supplier_code: str, erp_code: str):
        """Detect regex-based transformation patterns"""
        
        # Pattern: Remove everything after last separator
        for sep in ['-', '_', '.']:
            if sep in supplier_code and sep not in erp_code:
                parts = supplier_code.split(sep)
                if parts[0] == erp_code:
                    pattern = f"{re.escape(sep)}.*$"
                    self._add_or_update_rule(
                        rule_type='regex_replacement',
                        pattern=pattern,
                        replacement='',
                        supplier_id=supplier_id,
                        example=(supplier_code, erp_code)
                    )
                    logger.info(f"Learned regex pattern: remove everything after '{sep}'")
        
        # Pattern: Extract only numbers
        supplier_numbers = ''.join(filter(str.isdigit, supplier_code))
        erp_numbers = ''.join(filter(str.isdigit, erp_code))
        if supplier_numbers == erp_numbers and supplier_numbers:
            # Check if ERP code is just the numbers
            if erp_code == supplier_numbers:
                pattern = r'[^0-9]'
                self._add_or_update_rule(
                    rule_type='regex_replacement',
                    pattern=pattern,
                    replacement='',
                    supplier_id=supplier_id,
                    example=(supplier_code, erp_code)
                )
                logger.info("Learned regex pattern: extract only numbers")
    
    def _generalize_rules(self, supplier_id: str, corrections: List[Tuple[str, str]]):
        """
        Generalize rules from multiple corrections
        Look for patterns that apply to multiple cases
        """
        # Group by rule type
        suffix_patterns = Counter()
        prefix_patterns = Counter()
        prefix_addition_patterns = Counter()
        suffix_addition_patterns = Counter()
        separator_patterns = Counter()
        
        for supplier_code, erp_code in corrections:
            # Check prefix additions (ERP has prefix)
            if erp_code.endswith(supplier_code) and len(erp_code) > len(supplier_code):
                prefix = erp_code[:-len(supplier_code)]
                if prefix:
                    prefix_addition_patterns[prefix] += 1
            
            # Check suffix additions (ERP has suffix)
            if erp_code.startswith(supplier_code) and len(erp_code) > len(supplier_code):
                suffix = erp_code[len(supplier_code):]
                if suffix:
                    suffix_addition_patterns[suffix] += 1
            
            # Check suffix removals (supplier has suffix)
            if supplier_code.startswith(erp_code):
                suffix = supplier_code[len(erp_code):]
                if suffix:
                    suffix_patterns[suffix] += 1
            
            # Check prefix removals (supplier has prefix)
            if supplier_code.endswith(erp_code):
                prefix = supplier_code[:-len(erp_code)]
                if prefix:
                    prefix_patterns[prefix] += 1
            
            # Check separators
            for sep in ['-', '_', '.', ' ', '/']:
                if sep in supplier_code and sep not in erp_code:
                    separator_patterns[sep] += 1
        
        # Create generalized rules if pattern appears 3+ times
        for prefix, count in prefix_addition_patterns.items():
            if count >= 3:
                self._add_or_update_rule(
                    rule_type='prefix_addition',
                    pattern=prefix,
                    replacement='',
                    supplier_id=supplier_id,
                    example=None,
                    boost_confidence=count / len(corrections)
                )
                logger.info(f"Generalized prefix addition rule: '{prefix}' (seen {count} times)")
        
        for suffix, count in suffix_addition_patterns.items():
            if count >= 3:
                self._add_or_update_rule(
                    rule_type='suffix_addition',
                    pattern=suffix,
                    replacement='',
                    supplier_id=supplier_id,
                    example=None,
                    boost_confidence=count / len(corrections)
                )
                logger.info(f"Generalized suffix addition rule: '{suffix}' (seen {count} times)")
        
        for suffix, count in suffix_patterns.items():
            if count >= 3:
                self._add_or_update_rule(
                    rule_type='suffix_removal',
                    pattern=suffix,
                    replacement='',
                    supplier_id=supplier_id,
                    example=None,
                    boost_confidence=count / len(corrections)
                )
                logger.info(f"Generalized suffix removal rule: '{suffix}' (seen {count} times)")
        
        for prefix, count in prefix_patterns.items():
            if count >= 3:
                self._add_or_update_rule(
                    rule_type='prefix_removal',
                    pattern=prefix,
                    replacement='',
                    supplier_id=supplier_id,
                    example=None,
                    boost_confidence=count / len(corrections)
                )
                logger.info(f"Generalized prefix removal rule: '{prefix}' (seen {count} times)")
        
        for sep, count in separator_patterns.items():
            if count >= 3:
                self._add_or_update_rule(
                    rule_type='separator_removal',
                    pattern=sep,
                    replacement='',
                    supplier_id=supplier_id,
                    example=None,
                    boost_confidence=count / len(corrections)
                )
                logger.info(f"Generalized separator removal: '{sep}' (seen {count} times)")
    
    def _add_or_update_rule(self, rule_type: str, pattern: str, replacement: str,
                           supplier_id: str, example: Optional[Tuple[str, str]] = None,
                           boost_confidence: float = 0.0):
        """Add a new rule or update existing one"""
        
        # Check if rule already exists
        for rule in self.rules:
            if (rule.rule_type == rule_type and 
                rule.pattern == pattern and 
                rule.replacement == replacement and
                rule.supplier_id == supplier_id):
                # Update existing rule
                if example and example not in rule.examples:
                    rule.examples.append(example)
                if boost_confidence > 0:
                    rule.confidence = min(1.0, rule.confidence + boost_confidence)
                return
        
        # Create new rule
        confidence = 0.5 + boost_confidence  # Start with 50% confidence
        rule = TransformationRule(rule_type, pattern, replacement, supplier_id, confidence)
        if example:
            rule.examples.append(example)
        self.rules.append(rule)
    
    def apply_rules(self, supplier_id: str, supplier_code: str) -> List[Tuple[str, TransformationRule, float]]:
        """
        Apply all applicable rules to a supplier code
        
        Returns:
            List of (transformed_code, rule, confidence) tuples
        """
        results = []
        
        for rule in self.rules:
            # Check if rule applies to this supplier
            if rule.supplier_id and rule.supplier_id != supplier_id:
                continue
            
            # Try to apply rule
            transformed = rule.apply(supplier_code)
            if transformed and transformed != supplier_code:
                # Calculate confidence based on rule confidence and usage
                confidence = rule.confidence
                
                # Boost confidence for frequently used rules
                if rule.usage_count > 10:
                    confidence = min(1.0, confidence + 0.1)
                
                results.append((transformed, rule, confidence))
        
        # Sort by confidence
        results.sort(key=lambda x: x[2], reverse=True)
        
        return results
    
    def get_applicable_rules(self, supplier_id: str) -> List[TransformationRule]:
        """Get all rules applicable to a supplier"""
        return [r for r in self.rules 
                if r.supplier_id is None or r.supplier_id == supplier_id]
    
    def get_statistics(self) -> Dict:
        """Get statistics about learned rules"""
        total_rules = len(self.rules)
        supplier_specific = sum(1 for r in self.rules if r.supplier_id)
        global_rules = total_rules - supplier_specific
        
        rule_types = Counter(r.rule_type for r in self.rules)
        
        avg_confidence = sum(r.confidence for r in self.rules) / total_rules if total_rules > 0 else 0
        
        high_confidence = sum(1 for r in self.rules if r.confidence >= 0.8)
        
        return {
            'total_rules': total_rules,
            'supplier_specific_rules': supplier_specific,
            'global_rules': global_rules,
            'rule_types': dict(rule_types),
            'average_confidence': avg_confidence,
            'high_confidence_rules': high_confidence,
            'total_corrections': sum(len(v) for v in self.correction_history.values())
        }
    
    def explain_transformation(self, supplier_code: str, erp_code: str, rule: TransformationRule) -> str:
        """Generate human-readable explanation of a transformation"""
        explanations = {
            'prefix_addition': f"Add prefix '{rule.pattern}' to start",
            'suffix_addition': f"Add suffix '{rule.pattern}' to end",
            'suffix_removal': f"Remove suffix '{rule.pattern}' from end",
            'prefix_removal': f"Remove prefix '{rule.pattern}' from start",
            'character_replacement': f"Replace '{rule.pattern}' with '{rule.replacement}'",
            'separator_removal': f"Remove separator '{rule.pattern}'",
            'regex_replacement': f"Apply pattern: {rule.pattern}"
        }
        
        base_explanation = explanations.get(rule.rule_type, "Apply transformation")
        
        examples_text = ""
        if rule.examples:
            examples_text = f" (e.g., {rule.examples[0][0]} → {rule.examples[0][1]})"
        
        return f"{base_explanation}{examples_text}"


if __name__ == '__main__':
    # Test the rule learning engine
    engine = RuleLearningEngine('test_rules.json')
    
    # Simulate user corrections
    print("=== Simulating User Corrections ===\n")
    
    corrections = [
        ("101", "71628-A", "71628"),
        ("101", "71629-A", "71629"),
        ("101", "71630-A", "71630"),
        ("101", "31-74333", "317-74333"),
        ("101", "31-74677", "317-74677"),
    ]
    
    for supplier_id, supplier_code, erp_code in corrections:
        print(f"User corrected: {supplier_code} → {erp_code}")
        engine.record_correction(supplier_id, supplier_code, erp_code)
        print()
    
    print("\n=== Learned Rules ===\n")
    for rule in engine.rules:
        print(rule)
    
    print("\n=== Testing Rule Application ===\n")
    test_codes = ["71631-A", "71632-A", "31-74444"]
    for code in test_codes:
        results = engine.apply_rules("101", code)
        print(f"Code: {code}")
        for transformed, rule, confidence in results:
            explanation = engine.explain_transformation(code, transformed, rule)
            print(f"  → {transformed} ({confidence:.0%} confidence)")
            print(f"     {explanation}")
        print()
    
    print("\n=== Statistics ===\n")
    stats = engine.get_statistics()
    for key, value in stats.items():
        print(f"{key}: {value}")
