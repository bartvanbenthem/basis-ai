//! Lenient decoding: a field of an unexpected type stays at its default and
//! the rest still decodes, so a status field an operator changes in a later
//! version never blocks a reconcile. Serde stops at the first mismatch; the
//! `lenient!` structs give every field its own fallback instead.

use serde::de::{DeserializeOwned, Deserializer};
use serde::Deserialize;
use serde_json::Value;

/// A field's deserializer: its value, or its default when it doesn't fit.
pub fn de<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

/// Decodes a JSON value into T, its default for what doesn't fit.
pub fn decode<T: DeserializeOwned + Default>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap_or_default()
}

/// A struct whose every field decodes leniently and defaults when missing:
///
/// ```ignore
/// lenient! {
///     #[serde(rename_all = "camelCase")]
///     pub struct Spec { pub replicas: Option<i64>, pub site: String }
/// }
/// ```
#[macro_export]
macro_rules! lenient {
    ($(#[$sm:meta])* $vis:vis struct $name:ident {
        $( $(#[$fm:meta])* $fvis:vis $field:ident : $ty:ty ),* $(,)?
    }) => {
        #[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
        #[serde(default)]
        $(#[$sm])*
        $vis struct $name {
            $(
                $(#[$fm])*
                #[serde(deserialize_with = "crate::common::lenient::de")]
                $fvis $field: $ty,
            )*
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    lenient! {
        #[serde(rename_all = "camelCase")]
        struct Inner { ready_instances: i64, phase: String }
    }
    lenient! {
        struct Outer { a: i64, b: String, inner: Inner, list: Vec<String>, opt: Option<i64> }
    }

    #[test]
    fn keeps_what_fits() {
        let o: Outer = decode(&json!({
            "a": "not a number", "b": "kept", "inner": {"readyInstances": 2, "phase": 7},
            "list": ["x", 1], "opt": null, "extra": true,
        }));
        assert_eq!(o.a, 0);
        assert_eq!(o.b, "kept");
        assert_eq!(o.inner.ready_instances, 2);
        assert_eq!(o.inner.phase, "");
        // A list with one wrong item is wrong as a whole (Go zeroes just
        // that item; nothing relies on the difference).
        assert!(o.list.is_empty());
        assert_eq!(o.opt, None);
        let empty: Outer = decode(&json!("not an object"));
        assert_eq!(empty, Outer::default());
    }
}
