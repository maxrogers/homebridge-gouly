# Security

The Local Key controls your lights on your network. Treat it like a password:

- Never paste it into issues, discussions or logs you share.
- The plugin stores it in Homebridge's `config.json`, like every Homebridge plugin stores credentials.
- The plugin passes it to its Python helper through an environment variable, not the command line,
  and its diagnostic tools never print it.

To report a vulnerability, use GitHub's **Report a vulnerability** button on the Security tab of this
repository rather than opening a public issue.
