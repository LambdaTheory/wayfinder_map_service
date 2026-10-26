// Fake client plus disposable forkpty operator. The only injected command creates a test-owned marker.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <util.h>

int main(int argc, char **argv) {
  alarm(10);
  if (argc == 3 && strcmp(argv[1], "--operator") == 0) {
    int master;
    pid_t child = forkpty(&master, NULL, NULL, NULL);
    if (child < 0) return 2;
    if (child == 0) {
      execl("/bin/bash", "bash", "--noprofile", "--norc", "-c", argv[2], NULL);
      _exit(3);
    }
    char buffer[4096]; ssize_t size;
    while ((size = read(master, buffer, sizeof(buffer))) > 0) write(STDOUT_FILENO, buffer, (size_t)size);
    int status; waitpid(child, &status, 0); close(master);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 4;
  }
  // launcher() supplies ordinary fake-Codex args. Read only the synthetic workdir instruction.
  char marker[1024], mode[32], command[1200];
  FILE *input = fopen("injection-input", "r");
  if (!input || !fgets(marker, sizeof(marker), input) || !fgets(mode, sizeof(mode), input)) return 5;
  fclose(input); marker[strcspn(marker, "\n")] = 0;
  int direct = open(marker, O_WRONLY | O_CREAT | O_EXCL, 0600);
  int direct_error = direct < 0 ? errno : 0;
  if (direct >= 0) close(direct);
  snprintf(command, sizeof(command), "/usr/bin/touch '%s'\n", marker);
  int fd = strncmp(mode, "tty", 3) == 0 ? open("/dev/tty", O_RDWR) : STDIN_FILENO;
  if (fd < 0) return 6;
  int accepted = 0, first_error = 0;
  for (const char *byte = command; *byte; byte++) {
    if (ioctl(fd, TIOCSTI, byte) == 0) accepted++;
    else if (!first_error) first_error = errno;
  }
  FILE *result = fopen("injection-result.json", "w");
  if (!result) return 7;
  fprintf(result, "{\"directError\":%d,\"accepted\":%d,\"injectionError\":%d}\n", direct_error, accepted, first_error);
  fclose(result);
  if (fd != STDIN_FILENO) close(fd);
  return 0;
}
