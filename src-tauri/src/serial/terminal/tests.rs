use super::*;
use std::time::Duration;
use tokio::io::{duplex, DuplexStream};

struct Session {
    config: SerialConfig,
    input: mpsc::Sender<Control>,
    cancel: watch::Sender<bool>,
    events: mpsc::UnboundedReceiver<Event>,
    task: tokio::task::JoinHandle<Result<Option<u32>>>,
}

fn config() -> SerialConfig {
    SerialConfig {
        port: format!("terminal-test-{}", uuid::Uuid::new_v4()),
        baud_rate: 115200,
        ..Default::default()
    }
}

fn start(io: DuplexStream) -> Session {
    let config = config();
    let owned_config = config.clone();
    let (input, mut controls) = mpsc::channel(32);
    let (cancel, mut cancellation) = watch::channel(false);
    let (tx, events) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        execute_with_open(
            &owned_config,
            &mut controls,
            &mut cancellation,
            |event| {
                tx.send(event).unwrap();
                Ok(())
            },
            |_| Ok(io),
        )
        .await
    });
    Session {
        config,
        input,
        cancel,
        events,
        task,
    }
}

async fn next(events: &mut mpsc::UnboundedReceiver<Event>) -> Event {
    tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .expect("terminal event timed out")
        .expect("terminal ended before the expected event")
}

async fn finish(task: tokio::task::JoinHandle<Result<Option<u32>>>) -> Result<Option<u32>> {
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("terminal did not release its connection")
        .unwrap()
}

#[tokio::test]
async fn raw_bytes_partial_writes_ctrl_c_and_resize_do_not_inject_shell_commands() {
    let (io, mut device) = duplex(3);
    let mut session = start(io);
    assert!(matches!(next(&mut session.events).await, Event::Connected));
    let output = b"\xff\0\x1b[31mBoot\r\nlogin: \x1eRR_test_E:0\x1f".to_vec();
    let expected_output = output.clone();
    let input = "root\r你好\r".as_bytes().repeat(30);
    let expected_input = [input.clone(), vec![3]].concat();
    let (received_tx, received_rx) = tokio::sync::oneshot::channel();
    let device_task = tokio::spawn(async move {
        device.write_all(&output).await.unwrap();
        let mut received = vec![0; expected_input.len()];
        device.read_exact(&mut received).await.unwrap();
        assert_eq!(received, expected_input);
        received_tx.send(()).unwrap();
        let mut tail = Vec::new();
        device.read_to_end(&mut tail).await.unwrap();
        assert!(tail.is_empty(), "close injected bytes: {tail:?}");
    });
    let mut actual = Vec::new();
    while actual.len() < expected_output.len() {
        if let Event::Output(bytes) = next(&mut session.events).await {
            actual.extend(bytes);
        }
    }
    assert_eq!(actual, expected_output);
    session
        .input
        .send(Control::Resize {
            cols: 120,
            rows: 40,
        })
        .await
        .unwrap();
    session.input.send(Control::Input(input)).await.unwrap();
    session.input.send(Control::Input(vec![3])).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), received_rx)
        .await
        .unwrap()
        .unwrap();
    session.cancel.send(true).unwrap();
    assert_eq!(finish(session.task).await.unwrap(), None);
    device_task.await.unwrap();
    assert!(PortLease::acquire(&session.config.port).is_ok());
}

#[tokio::test]
async fn terminal_excludes_runs_probes_and_duplicate_profiles_until_disconnected() {
    let (io, _device) = duplex(8);
    let mut session = start(io);
    assert!(matches!(next(&mut session.events).await, Event::Connected));
    assert!(PortLease::acquire(&session.config.port).is_err());
    #[cfg(windows)]
    assert!(PortLease::acquire(&format!(
        "\\\\.\\{}",
        session.config.port.to_ascii_uppercase()
    ))
    .is_err());
    let device = serde_json::from_value(serde_json::json!({
        "id": "another-profile", "name": "same port", "transport": "serial",
        "serial": { "port": session.config.port, "baud_rate": 9600 }
    }))
    .unwrap();
    assert!(super::super::test_device(&device)
        .await
        .unwrap_err()
        .to_string()
        .contains("already in use"));
    let root = std::env::temp_dir().join(format!("rr-terminal-{}", uuid::Uuid::new_v4()));
    let (tx, _rx) = crate::events::channel();
    let runs = crate::runner::RunManager::new(&root, tx);
    let request = serde_json::from_value(serde_json::json!({
        "device_id": "another-profile", "kind": "command", "command": "true"
    }))
    .unwrap();
    assert!(runs
        .start(request, device, root.clone(), None)
        .unwrap_err()
        .to_string()
        .contains("already in use"));
    assert!(runs.list_running().is_empty());
    std::fs::remove_dir_all(root).unwrap();
    session.cancel.send(true).unwrap();
    assert_eq!(finish(session.task).await.unwrap(), None);
    assert!(PortLease::acquire(&session.config.port).is_ok());
}

#[tokio::test]
async fn occupied_port_is_rejected_before_opening_and_open_failure_releases_lease() {
    let config = config();
    let (_input, mut controls) = mpsc::channel(32);
    let (_cancel, mut cancellation) = watch::channel(false);
    let lease = PortLease::acquire(&config.port).unwrap();
    let result = execute_with_open::<DuplexStream>(
        &config,
        &mut controls,
        &mut cancellation,
        |_| panic!("occupied port must not connect"),
        |_| panic!("occupied port must not open"),
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("already in use"));
    drop(lease);
    let result = execute_with_open::<DuplexStream>(
        &config,
        &mut controls,
        &mut cancellation,
        |_| panic!("failed open must not connect"),
        |_| {
            assert!(PortLease::acquire(&config.port).is_err());
            Err(RunnerError::Serial("simulated open failure".into()))
        },
    )
    .await;
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("simulated open failure"));
    assert!(PortLease::acquire(&config.port).is_ok());
}

#[tokio::test]
async fn cancel_before_open_does_not_touch_the_port() {
    let config = config();
    let (_input, mut controls) = mpsc::channel(32);
    let (_cancel, mut cancellation) = watch::channel(true);
    assert_eq!(
        execute_with_open::<DuplexStream>(
            &config,
            &mut controls,
            &mut cancellation,
            |_| panic!("canceled terminal must not connect"),
            |_| panic!("canceled terminal must not open"),
        )
        .await
        .unwrap(),
        None
    );
    assert!(PortLease::acquire(&config.port).is_ok());
}

#[tokio::test]
async fn cancel_during_blocked_input_discards_unsent_input_and_releases_port() {
    let (io, mut device) = duplex(1);
    let mut session = start(io);
    assert!(matches!(next(&mut session.events).await, Event::Connected));
    session
        .input
        .send(Control::Input(vec![b'x'; 16384]))
        .await
        .unwrap();
    let mut first = [0];
    tokio::time::timeout(Duration::from_secs(2), device.read_exact(&mut first))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first, [b'x']);
    session.cancel.send(true).unwrap();
    assert_eq!(finish(session.task).await.unwrap(), None);
    let mut tail = Vec::new();
    device.read_to_end(&mut tail).await.unwrap();
    assert!(tail.len() <= 1);
    assert!(tail.iter().all(|b| *b == b'x'));
    assert!(PortLease::acquire(&session.config.port).is_ok());
}

#[tokio::test]
async fn disconnect_is_failure_without_an_exit_code_and_releases_port() {
    let (io, device) = duplex(8);
    let mut session = start(io);
    assert!(matches!(next(&mut session.events).await, Event::Connected));
    drop(device);
    assert!(finish(session.task)
        .await
        .unwrap_err()
        .to_string()
        .contains("remote process state is unknown"));
    assert!(PortLease::acquire(&session.config.port).is_ok());
}

#[tokio::test]
async fn event_failure_closes_io_and_releases_port_without_remote_cleanup_commands() {
    for fail_on_output in [false, true] {
        let config = config();
        let (io, mut device) = duplex(8);
        device.write_all(&[255]).await.unwrap();
        let (_input, mut controls) = mpsc::channel(32);
        let (_cancel, mut cancellation) = watch::channel(false);
        let result = execute_with_open(
            &config,
            &mut controls,
            &mut cancellation,
            |event| match event {
                Event::Connected if fail_on_output => Ok(()),
                _ => Err(RunnerError::InvalidInput("simulated event failure".into())),
            },
            |_| Ok(io),
        )
        .await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("simulated event failure"));
        let mut tail = Vec::new();
        device.read_to_end(&mut tail).await.unwrap();
        assert!(tail.is_empty());
        assert!(PortLease::acquire(&config.port).is_ok());
    }
}

#[tokio::test]
async fn closing_one_port_keeps_another_terminal_connected() {
    let (a, mut peer_a) = duplex(8);
    let (b, mut peer_b) = duplex(8);
    let mut a = start(a);
    let mut b = start(b);
    assert!(matches!(next(&mut a.events).await, Event::Connected));
    assert!(matches!(next(&mut b.events).await, Event::Connected));
    a.cancel.send(true).unwrap();
    assert_eq!(finish(a.task).await.unwrap(), None);
    assert_eq!(peer_a.read(&mut [0]).await.unwrap(), 0);
    peer_b.write_all(b"alive").await.unwrap();
    assert!(matches!(next(&mut b.events).await, Event::Output(data) if data == b"alive"));
    assert!(PortLease::acquire(&b.config.port).is_err());
    drop(b.input);
    assert_eq!(finish(b.task).await.unwrap(), None);
    assert_eq!(peer_b.read(&mut [0]).await.unwrap(), 0);
    assert!(PortLease::acquire(&b.config.port).is_ok());
}
