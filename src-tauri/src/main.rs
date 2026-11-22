// no console window behind Crib on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    crib_lib::run()
}
