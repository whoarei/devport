use super::{error, host::Handle, Attributes, Entry, Result, CHUNK};
use crate::{
    device::WslConfig,
    wsl::{helper_command, Bridge, Message},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};

pub(super) struct WslHost {
    bridge: Bridge,
    pub root: String,
    pub local_alias: Option<PathBuf>,
}

impl WslHost {
    pub async fn open(config: &WslConfig, path: &str) -> Result<Self> {
        let bridge =
            Bridge::launch(helper_command(config).map_err(|e| error("io", e.to_string()))?)
                .await
                .map_err(|e| error("io", e.to_string()))?;
        let mut host = Self {
            bridge,
            root: path.into(),
            local_alias: None,
        };
        let response = host.call(json!({"type":"tf_open", "path":path})).await?;
        host.root = response["root"]
            .as_str()
            .ok_or_else(|| error("io", "Missing WSL root"))?
            .into();
        #[cfg(windows)]
        if let Some(path) = response["windows_path"].as_str() {
            let path = path.replace("\\\\wsl.localhost\\", "\\\\wsl$\\");
            host.local_alias =
                Some(std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(path)));
        }
        Ok(host)
    }

    pub async fn call(&mut self, request: Value) -> Result<Value> {
        self.bridge
            .send(request)
            .await
            .map_err(|e| error("io", e.to_string()))?;
        match tokio::time::timeout(Duration::from_secs(60), self.bridge.next())
            .await
            .map_err(|_| error("io", "WSL file transfer timed out"))?
            .map_err(|e| error("io", e.to_string()))?
        {
            Message::TransferReply { result } => Ok(result),
            Message::FsError { code, message } => Err(error(
                match code.as_str() {
                    "not_found" => "not_found",
                    "exists" => "exists",
                    "permission" => "permission",
                    "conflict" => "conflict",
                    "path" => "path",
                    "too_large" => "too_large",
                    _ => "io",
                },
                message,
            )),
            _ => Err(error("io", "Unexpected WSL transfer response")),
        }
    }
    pub async fn stat(&mut self, path: &str) -> Result<Option<Attributes>> {
        let response = match self.call(json!({"type":"tf_stat","path":path})).await {
            Ok(response) => response,
            Err(e) if e.code == "not_found" => return Ok(None),
            Err(e) => return Err(e),
        };
        serde_json::from_value(response).map_err(|e| error("io", e.to_string()))
    }
    pub async fn list(&mut self, path: &str) -> Result<Vec<Entry>> {
        self.bridge
            .send(json!({"type":"tf_list","path":path}))
            .await
            .map_err(|e| error("io", e.to_string()))?;
        let mut entries = Vec::new();
        loop {
            let result = tokio::time::timeout(Duration::from_secs(60), self.bridge.next())
                .await
                .map_err(|_| error("io", "WSL listing timed out"))?
                .map_err(|e| error("io", e.to_string()))?;
            match result {
                Message::TransferReply { result } if result.is_null() => break,
                Message::TransferReply { result } => {
                    if entries.len() >= super::ENTRY_LIMIT {
                        return Err(error("too_large", "Directory exceeds 10000 entries"));
                    }
                    entries.push(
                        serde_json::from_value(result).map_err(|e| error("io", e.to_string()))?,
                    );
                }
                Message::FsError { message, .. } => return Err(error("io", message)),
                _ => return Err(error("io", "Unexpected WSL listing response")),
            }
        }
        Ok(entries)
    }
    pub async fn mkdir(&mut self, path: &str) -> Result<()> {
        self.call(json!({"type":"tf_mkdir","path":path})).await?;
        Ok(())
    }
    pub async fn open_file(&mut self, path: &str, create: bool) -> Result<(Handle, Attributes)> {
        let r = self
            .call(json!({"type":"tf_file","path":path,"create":create}))
            .await?;
        Ok((
            Handle::Remote(
                r["handle"]
                    .as_str()
                    .ok_or_else(|| error("io", "Missing WSL handle"))?
                    .into(),
            ),
            serde_json::from_value(r["attrs"].clone()).map_err(|e| error("io", e.to_string()))?,
        ))
    }
    pub async fn read(&mut self, handle: &str, offset: u64) -> Result<Vec<u8>> {
        let r = self
            .call(json!({"type":"tf_read","handle":handle,"offset":offset}))
            .await?;
        let bytes = STANDARD
            .decode(r.as_str().ok_or_else(|| error("io", "Invalid WSL chunk"))?)
            .map_err(|_| error("io", "Invalid WSL encoding"))?;
        if bytes.len() > CHUNK {
            return Err(error("io", "Oversized WSL transfer chunk"));
        }
        Ok(bytes)
    }
    pub async fn write(&mut self, handle: &str, offset: u64, bytes: Vec<u8>) -> Result<()> {
        self.call(json!({"type":"tf_write","handle":handle,"offset":offset,"data":STANDARD.encode(bytes)})).await?;
        Ok(())
    }
    pub async fn close(
        &mut self,
        handle: String,
        writing: bool,
        mode: Option<u32>,
    ) -> Result<Attributes> {
        serde_json::from_value(
            self.call(json!({"type":"tf_close","handle":handle,"writing":writing,"mode":mode}))
                .await?,
        )
        .map_err(|e| error("io", e.to_string()))
    }
    pub async fn commit(
        &mut self,
        temp: &str,
        path: &str,
        overwrite: bool,
        expected: &Option<Attributes>,
    ) -> Result<()> {
        self.call(json!({"type":"tf_commit","temp":temp,"path":path,"overwrite":overwrite,"expected":expected})).await?;
        Ok(())
    }
    pub async fn remove(&mut self, path: &str) -> Result<()> {
        self.call(json!({"type":"tf_remove","path":path})).await?;
        Ok(())
    }
}
