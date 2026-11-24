idf_component_register(
    SRCS "main.c" "config.c" "portal.c" "net.c" "face.c" "ui.c" "mind.c" "audio.c" "session.c" "power.c"
    INCLUDE_DIRS "."
    REQUIRES nvs_flash esp_wifi esp_netif esp_event esp_http_server esp_partition esp_timer esp_driver_gpio esp_driver_i2c json mbedtls)

# La cara 2D (cara.bin, hecha con `npm run cara:placa`) se graba en su particion junto con el programa.
set(CARA "${CMAKE_SOURCE_DIR}/cara.bin")
if(NOT EXISTS "${CARA}")
    message(FATAL_ERROR "Falta placa/cara.bin. En la carpeta kiosco-avatar corre: npm run cara:placa")
endif()
esptool_py_flash_to_partition(flash "cara" "${CARA}")
