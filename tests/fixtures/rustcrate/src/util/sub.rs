use super::greet;
use crate::util::{greet as g2};

pub fn shout() -> String {
    greet().to_uppercase()
}
