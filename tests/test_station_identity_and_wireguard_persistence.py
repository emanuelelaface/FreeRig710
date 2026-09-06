from pathlib import Path

root = Path(__file__).resolve().parents[1]
cfg_h = (root / "components/freerig_config/include/freerig_config.h").read_text()
cfg_c = (root / "components/freerig_config/freerig_config.c").read_text()
api_c = (root / "components/web_api/control_api.c").read_text()
app_js = (root / "frontend/app.js").read_text()
ft8_js = (root / "frontend/ft8.js").read_text()
js8_js = (root / "frontend/js8-page.js").read_text()
rtty_js = (root / "frontend/rtty-page.js").read_text()

assert "#define FREERIG_STATION_GRID_MAX 9" in cfg_h
assert "char station_grid[FREERIG_STATION_GRID_MAX]" in cfg_h
assert 'nvs_get_str(h, "station_grid"' in cfg_c
assert 'nvs_set_str(h, "station_grid", grid)' in cfg_c
assert 'nvs_erase_key(h, "station_grid")' in cfg_c
assert "valid_station_grid" in cfg_c

assert 'cJSON_AddStringToObject(x, "station_grid"' in api_c
assert 'cJSON_AddStringToObject(x, "grid_square"' in api_c
assert 'json_string(j, "station_grid"' in api_c
assert "freerig_config_set_log(call, grid, key" in api_c
assert '(my_grid && my_grid[0]) ? my_grid : q.station_grid' in api_c

assert "freerig_wireguard_stop()" in api_c
assert "network_wifi_apply_config()" in api_c
assert "freerig_wireguard_apply_saved_config_async()" in api_c
assert api_c.index("freerig_wireguard_stop()") < api_c.index("network_wifi_apply_config()")

assert "station_grid: grid" in app_js
assert "logStatusGrid" in app_js
assert "wireguardSettingsLoaded" in app_js
assert "saved ESP32 config was left unchanged" in app_js
assert app_js.index('post("/api/v1/wireguard/config"') < app_js.index('post("/api/v1/wifi/config"')

for js in (ft8_js, js8_js, rtty_js):
    assert "station_grid" in js
    assert "grid_square" in js

print("Station identity and WireGuard persistence static contract: OK")
