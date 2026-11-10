#!/bin/bash
set -e
LOG=/tmp/xuanpin_setup.log
exec > >(tee -a "$LOG") 2>&1

echo "=== 1. 安装目录 ==="
mkdir -p /opt/xuanpin
cp /home/ubantu/xuanpin-tmp/app.py /opt/xuanpin/app.py
cp /home/ubantu/xuanpin-tmp/requirements.txt /opt/xuanpin/requirements.txt
chown -R ubantu:ubantu /opt/xuanpin
ls -l /opt/xuanpin

echo "=== 2. Python venv / 依赖 ==="
export DEBIAN_FRONTEND=noninteractive
apt-get install -y python3-venv python3-pip >/dev/null
if [ ! -x /opt/xuanpin/venv/bin/python ]; then
  sudo -u ubantu python3 -m venv /opt/xuanpin/venv
fi
sudo -u ubantu /opt/xuanpin/venv/bin/pip install -q --upgrade pip -i https://mirrors.aliyun.com/pypi/simple/
sudo -u ubantu /opt/xuanpin/venv/bin/pip install -q -r /opt/xuanpin/requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
/opt/xuanpin/venv/bin/python -c "import flask; print('flask', flask.__version__)"

echo "=== 3. 语法自检 ==="
sudo -u ubantu /opt/xuanpin/venv/bin/python -m py_compile /opt/xuanpin/app.py
echo "syntax ok"

echo "=== 4. systemd 服务 ==="
cat > /etc/systemd/system/xuanpin.service <<'EOF'
[Unit]
Description=Shopee Selector Backend (Ubuntu)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubantu
Group=ubantu
WorkingDirectory=/opt/xuanpin
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/xuanpin/venv/bin/python /opt/xuanpin/app.py
Restart=always
RestartSec=5
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=xuanpin

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable xuanpin >/dev/null 2>&1
systemctl restart xuanpin
sleep 3

echo "=== 5. 启动结果 ==="
systemctl is-active xuanpin
systemctl is-enabled xuanpin
ss -lntp | grep 4180 || echo "端口未监听"
echo "--- healthz ---"
curl -s http://127.0.0.1:4180/healthz
echo
echo "--- 最近日志 ---"
journalctl -u xuanpin -n 15 --no-pager
