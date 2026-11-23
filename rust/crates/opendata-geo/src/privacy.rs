//! The privacy classification of `packages/core/src/privacy.ts`.
//! Only `Classification::Legal` records may be written.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Classification {
    Legal,
    Natural,
    Unknown,
}

impl Classification {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Legal => "legal",
            Self::Natural => "natural",
            Self::Unknown => "unknown",
        }
    }
}

pub fn luhn_valid(digits: &str) -> bool {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let sum: u32 = digits
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, b)| {
            let mut d = u32::from(b - b'0');
            if i % 2 == 1 {
                d *= 2;
                if d > 9 {
                    d -= 9;
                }
            }
            d
        })
        .sum();
    sum.is_multiple_of(10)
}

/// 10 digits, Luhn-valid, third digit >= 2.
pub fn is_legal_entity_number(digits: &str) -> bool {
    digits.len() == 10 && digits.as_bytes()[2] >= b'2' && luhn_valid(digits)
}

fn normalise(id: &str) -> String {
    let digits: String = id.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    if digits.len() == 12 && digits.starts_with("16") && digits.bytes().all(|b| b.is_ascii_digit()) {
        digits[2..].to_string()
    } else {
        digits
    }
}

/// Canonical 10-digit organisationsnummer, or None if not a legal entity number.
pub fn parse_orgnr(id: &str) -> Option<String> {
    let digits = normalise(id);
    is_legal_entity_number(&digits).then_some(digits)
}

pub fn classify(id: &str, jurform: Option<&str>, bv_form: Option<&str>, id_type: Option<&str>) -> Classification {
    if let Some(t) = id_type {
        let upper = t.to_ascii_uppercase();
        if upper.contains("PERSON") || upper.contains("SAMORD") {
            return Classification::Natural;
        }
    }
    if matches!(jurform.map(str::trim), Some("10" | "91")) {
        return Classification::Natural;
    }
    if let Some(form) = bv_form {
        let code = form.trim_end_matches("-ORGFO");
        if matches!(code, "E" | "EF" | "ENK") {
            return Classification::Natural;
        }
    }
    let digits = normalise(id);
    if is_legal_entity_number(&digits) {
        return Classification::Legal;
    }
    let all_digits = digits.bytes().all(|b| b.is_ascii_digit());
    if all_digits && (digits.len() == 12 || (digits.len() == 10 && digits.as_bytes()[2] <= b'1')) {
        return Classification::Natural;
    }
    Classification::Unknown
}
