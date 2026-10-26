// Only disposable ptys created here are inspected. No operator terminal is opened by the harness.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>

int main(int argc, char **argv) {
  alarm(5);
  if (argc == 3 && strcmp(argv[1], "--client") == 0) {
    int tty = open("/dev/tty", O_RDWR | O_NOCTTY);
    int own_read = 0, own_write = 0;
    if (tty >= 0) {
      char byte;
      own_write = write(tty, "own-write\n", 10) == 10;
      own_read = read(tty, &byte, 1) == 1 && byte == 'x';
      close(tty);
    }
    int peer = open(argv[2], O_RDONLY | O_NONBLOCK);
    int peer_read = peer >= 0 ? 0 : errno;
    if (peer >= 0) close(peer);
    peer = open(argv[2], O_WRONLY | O_NONBLOCK);
    int peer_write = peer >= 0 ? 0 : errno;
    if (peer >= 0) { write(peer, "forged", 6); close(peer); }
    printf("{\"ownRead\":%d,\"ownWrite\":%d,\"peerReadError\":%d,\"peerWriteError\":%d}\n",
      own_read, own_write, peer_read, peer_write);
    return 0;
  }
  if (argc != 2) return 2;
  int peer_master, peer_slave, master;
  char name[128];
  if (openpty(&peer_master, &peer_slave, name, NULL, NULL) != 0) return 3;
  // Positive controls: this same-user slave is readable and writable without Seatbelt.
  int fd = open(name, O_RDWR | O_NONBLOCK);
  if (fd < 0) return 4;
  close(fd);
  pid_t child = forkpty(&master, NULL, NULL, NULL);
  if (child < 0) return 5;
  if (child == 0) {
    close(peer_master); close(peer_slave);
    execl("/usr/bin/sandbox-exec", "sandbox-exec", "-f", argv[1], argv[0], "--client", name, NULL);
    _exit(6);
  }
  write(master, "x\n", 2);
  char buffer[4096]; ssize_t size;
  while ((size = read(master, buffer, sizeof(buffer))) > 0) write(STDOUT_FILENO, buffer, (size_t)size);
  int status; waitpid(child, &status, 0);
  close(master); close(peer_master); close(peer_slave);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 7;
}
