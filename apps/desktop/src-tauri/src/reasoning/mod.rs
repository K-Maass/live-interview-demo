#[cfg(not(feature = "public"))]
compile_error!("The source preview builds only the managed public edition.");

mod jobs;
pub mod locator;
mod managed;
pub mod protocol;
pub use managed::*;
