# Security

FreeRig710 can control and transmit through a real radio.

- Do not expose ESP32 port 80 directly to the public Internet.
- Put the ESP32 on a trusted private LAN/VLAN.
- For remote access, use the documented Apache HTTPS reverse proxy and authentication.
- Use strong Apache credentials and a real TLS certificate.
- Treat the QRZ Logbook API key as a password; it has read/write access to the selected logbook.
- Keep QRZ keys in ESP32 NVS and Apache password/session files outside Git.
- Test PTT and FT8 changes at low power or into a dummy load.
- Do not remove/disable the PTT watchdog, FT8 slot deadline or pre-key radio-state checks merely to make a failed TX start.

If you find a security issue, avoid publishing credentials, private network addresses or exploitable radio-control details in a public issue. Contact the repository owner privately first.
