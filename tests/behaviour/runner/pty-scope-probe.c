// Allocates only its own pty; peers are supplied by the test, never discovered on the host.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>

int main(int argc, char **argv) {
  alarm(10);
  int master, slave;
  char name[128];
  if (openpty(&master, &slave, name, NULL, NULL) != 0) { puts("{\"opened\":0}"); return 0; }
  if (argc == 2 && strcmp(argv[1], "--hold") == 0) {
    puts(name); fflush(stdout);
    char stop; read(STDIN_FILENO, &stop, 1);
    close(master); close(slave); return 0;
  }
  int reopened = open(name, O_RDWR | O_NOCTTY);
  struct termios raw;
  if (tcgetattr(slave, &raw) != 0) return 2;
  cfmakeraw(&raw);
  if (tcsetattr(slave, TCSANOW, &raw) != 0) return 3;
  char byte;
  int readable = write(master, "x", 1) == 1 && read(slave, &byte, 1) == 1 && byte == 'x';
  int writable = write(slave, "y", 1) == 1 && read(master, &byte, 1) == 1 && byte == 'y';
  printf("{\"opened\":1,\"reopened\":%d,\"readable\":%d,\"writable\":%d,\"peers\":[", reopened >= 0, readable, writable);
  for (int i = 1; i < argc; i++) {
    int fd = open(argv[i], O_RDONLY | O_NONBLOCK);
    int read_error = fd >= 0 ? 0 : errno;
    if (fd >= 0) close(fd);
    fd = open(argv[i], O_WRONLY | O_NONBLOCK);
    int write_error = fd >= 0 ? 0 : errno;
    if (fd >= 0) close(fd);
    printf("%s{\"readError\":%d,\"writeError\":%d}", i > 1 ? "," : "", read_error, write_error);
  }
  puts("]}");
  if (reopened >= 0) close(reopened);
  close(master); close(slave); return 0;
}
