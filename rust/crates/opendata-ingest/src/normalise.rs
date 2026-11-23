//! Address normalisation, identical to `packages/core/src/address.ts`
//! (checked against `contracts/vectors/core.json`).
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedAddress {
    pub street: String,
    pub number: Option<String>,
    pub letter: Option<String>,
}

pub fn normalise_text(value: &str) -> String {
    let upper: String = value.nfc().collect::<String>().to_uppercase();
    let replaced: String = upper.chars().map(|c| if matches!(c, '.' | ',' | ';' | ':') { ' ' } else { c }).collect();
    replaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

static LGH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bLGH\s*\d+\b").unwrap());
static CO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bC/O\b.*$").unwrap());
static STREET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(.*?)\s+(\d+)\s*([A-ZÅÄÖ])?(?:\s*[-–]\s*\d+[A-Z]?)?(?:\s+(?:TR|VÅN|BV|NB)\b.*)?$").unwrap()
});

pub fn parse_street_address(raw: &str) -> ParsedAddress {
    let text = normalise_text(raw);
    let text = LGH.replace_all(&text, "");
    let text = CO.replace(&text, "");
    let text = text.trim();
    match STREET.captures(text) {
        Some(c) => ParsedAddress {
            street: c[1].trim().to_string(),
            number: c.get(2).map(|m| m.as_str().to_string()),
            letter: c.get(3).map(|m| m.as_str().to_string()),
        },
        None => ParsedAddress { street: text.to_string(), number: None, letter: None },
    }
}

pub fn normalise_postcode(value: Option<&str>) -> Option<String> {
    let digits: String = value.unwrap_or("").chars().filter(char::is_ascii_digit).collect();
    (digits.len() == 5).then_some(digits)
}

pub fn match_key(street: &str, number: Option<&str>, letter: Option<&str>, postcode: Option<&str>) -> String {
    format!("{}|{}{}|{}", normalise_text(street), number.unwrap_or(""), letter.unwrap_or(""), postcode.unwrap_or(""))
}

pub fn address_label(street: &str, number: Option<&str>, letter: Option<&str>, postcode: Option<&str>, town: Option<&str>) -> String {
    let num = format!("{}{}", number.unwrap_or(""), letter.unwrap_or(""));
    let line1 = [street, num.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" ");
    let pc = postcode.map(|p| if p.len() == 5 { format!("{} {}", &p[..3], &p[3..]) } else { p.to_string() }).unwrap_or_default();
    let line2 = [pc.as_str(), town.unwrap_or("")].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" ");
    [line1, line2].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn matches_typescript_vectors() {
        let v: Value = serde_json::from_str(include_str!("../../../../contracts/vectors/core.json")).unwrap();
        for a in v["addresses"].as_array().unwrap() {
            let p = parse_street_address(a["raw"].as_str().unwrap());
            assert_eq!(p.street, a["parsed"]["street"].as_str().unwrap(), "{a}");
            assert_eq!(p.number.as_deref(), a["parsed"]["number"].as_str(), "{a}");
            assert_eq!(p.letter.as_deref(), a["parsed"]["letter"].as_str(), "{a}");
            assert_eq!(match_key(&p.street, p.number.as_deref(), p.letter.as_deref(), Some("41101")), a["key"].as_str().unwrap());
        }
    }
}
