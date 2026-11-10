use crate::device::{AuthMethod, DeviceProfile};
use crate::error::{Result, RunnerError};

#[derive(serde::Deserialize)]
pub struct Request {
    pub address: String,
    #[serde(default)]
    pub auth: AuthMethod,
}

impl Request {
    pub fn profile(self) -> Result<DeviceProfile> {
        let invalid = || {
            RunnerError::InvalidInput(
                "expected [user@]host[:port] or ssh://user@host:port; use brackets for IPv6".into(),
            )
        };
        let value = self.address.trim();
        if value.is_empty() || value.len() > 1024 || self.address.chars().any(char::is_control) {
            return Err(invalid());
        }
        let authority = if let Some(uri) = value.strip_prefix("ssh://") {
            uri.strip_suffix('/').unwrap_or(uri)
        } else {
            value
        };
        if authority
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '?' | '#'))
        {
            return Err(invalid());
        }
        let (username, host_port) = match authority.rsplit_once('@') {
            Some((user, target)) if !user.is_empty() && !user.contains(['@', ':']) => {
                (user, target)
            }
            Some(_) => return Err(invalid()),
            None => ("root", authority),
        };
        let (host, port) = if host_port.starts_with('[') {
            let end = host_port.find(']').ok_or_else(invalid)?;
            host_port[1..end]
                .parse::<std::net::Ipv6Addr>()
                .map_err(|_| invalid())?;
            (&host_port[..=end], &host_port[end + 1..])
        } else {
            match host_port.find(':') {
                Some(index) => (&host_port[..index], &host_port[index..]),
                None => (host_port, ""),
            }
        };
        let port = if port.is_empty() {
            22
        } else {
            port.strip_prefix(':')
                .ok_or_else(invalid)?
                .parse::<u16>()
                .map_err(|_| invalid())?
        };
        if host.is_empty() || host.starts_with('-') || host.contains('@') || port == 0 {
            return Err(invalid());
        }
        let device: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "", "name": format!("ssh-{username}@{host}:{port}"), "host": host, "port": port,
            "username": username, "auth": self.auth, "workspace_root": "~/"
        }))
        .map_err(|_| invalid())?;
        device.validate()?;
        Ok(device)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(address: &str) -> Result<DeviceProfile> {
        Request {
            address: address.into(),
            auth: AuthMethod::default(),
        }
        .profile()
    }
    #[test]
    fn parses_ssh_addresses_and_rejects_passwords_paths_and_invalid_ports() {
        for (address, username, host, port) in [
            ("example.com", "root", "example.com", 22),
            ("dev@example.com:2222", "dev", "example.com", 2222),
            ("ssh://alice@server:2200/", "alice", "server", 2200),
            ("root@[::1]:2222", "root", "[::1]", 2222),
            ("[2001:db8::1]", "root", "[2001:db8::1]", 22),
        ] {
            let profile = parse(address).unwrap();
            assert_eq!(
                (
                    profile.username.as_str(),
                    profile.host.as_str(),
                    profile.port
                ),
                (username, host, port)
            );
            assert_eq!(profile.workspace_root, "~/");
        }
        for address in [
            "",
            "@host",
            "root@",
            "user:password@host",
            "host:0",
            "host:65536",
            "host:abc",
            "host:",
            "host/path",
            "host?x=1",
            "host#x",
            "user@@host",
            "host\n",
            "ssh://host/path",
            "https://host",
            "[not-ipv6]",
            "::1",
            "host name",
            "-option",
        ] {
            assert!(parse(address).is_err(), "{address:?}");
        }
    }
}
