//! Build the opendata database and snapshot files from bulk open data.
#![forbid(unsafe_code)]
pub mod db;
pub mod deso;
pub mod export;
pub mod normalise;
pub mod readers;
pub mod schema;
